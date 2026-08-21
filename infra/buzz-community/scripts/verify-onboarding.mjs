import pg from "pg";

const { Client } = pg;
const COMMUNITY_HOST = "community.humanwareos.com";
const DEFAULT_CHANNELS = ["general", "welcome-everyone", "bugs"];
const PRIVATE_CHANNEL = "agent-testing";

if (!process.env.BUZZ_COMMUNITY_DATABASE_URL) {
  console.error("verification failed: BUZZ_COMMUNITY_DATABASE_URL is unavailable");
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.BUZZ_COMMUNITY_DATABASE_URL,
  statement_timeout: 15_000,
  query_timeout: 20_000,
});

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");

  const result = await client.query(
    `WITH community AS (
       SELECT id FROM communities WHERE host = $1
     ),
     invite_joiners AS (
       SELECT pubkey
       FROM relay_members
       WHERE community_id = (SELECT id FROM community)
         AND role = 'member'
         AND added_by = 'invite'
     ),
     default_channels AS (
       SELECT id, name
       FROM channels
       WHERE community_id = (SELECT id FROM community)
         AND name = ANY($2)
         AND visibility = 'open'
         AND archived_at IS NULL
         AND deleted_at IS NULL
     ),
     membership_pairs AS (
       SELECT cm.channel_id, encode(cm.pubkey, 'hex') AS pubkey
       FROM channel_members cm
       JOIN default_channels channel ON channel.id = cm.channel_id
       WHERE cm.community_id = (SELECT id FROM community)
         AND cm.removed_at IS NULL
     ),
     latest_member_snapshots AS (
       SELECT DISTINCT ON (channel.id)
         channel.id,
         event.tags
       FROM default_channels channel
       LEFT JOIN events event
         ON event.community_id = (SELECT id FROM community)
        AND event.channel_id = channel.id
        AND event.kind = 39002
        AND event.d_tag = channel.id::text
       ORDER BY channel.id, event.created_at DESC, event.received_at DESC
     ),
     private_channel AS (
       SELECT id, visibility
       FROM channels
       WHERE community_id = (SELECT id FROM community)
         AND name = $3
         AND archived_at IS NULL
         AND deleted_at IS NULL
     ),
     latest_private_snapshot AS (
       SELECT event.tags
       FROM events event
       JOIN private_channel channel ON channel.id = event.channel_id
       WHERE event.community_id = (SELECT id FROM community)
         AND event.kind = 39000
         AND event.d_tag = channel.id::text
       ORDER BY event.created_at DESC, event.received_at DESC
       LIMIT 1
     )
     SELECT
       (SELECT count(*) FROM invite_joiners)::int AS invite_joiners,
       (SELECT count(*) FROM default_channels)::int AS default_channels,
       (SELECT count(*) FROM membership_pairs pair
          JOIN invite_joiners joiner ON joiner.pubkey = pair.pubkey)::int AS membership_pairs,
       NOT EXISTS (
         SELECT 1
         FROM latest_member_snapshots snapshot
         CROSS JOIN invite_joiners joiner
         WHERE snapshot.tags IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(snapshot.tags) tag
              WHERE tag->>0 = 'p' AND tag->>1 = joiner.pubkey
            )
       ) AS snapshots_include_joiners,
       (SELECT count(*) = 1 AND bool_and(visibility = 'private') FROM private_channel)
         AS private_channel,
       EXISTS (
         SELECT 1 FROM latest_private_snapshot
         WHERE tags @> '[["private"]]'::jsonb
       ) AS private_snapshot`,
    [COMMUNITY_HOST, DEFAULT_CHANNELS, PRIVATE_CHANNEL],
  );

  await client.query("COMMIT");
  const proof = result.rows[0];
  const expectedPairs = proof.invite_joiners * DEFAULT_CHANNELS.length;
  const ok =
    proof.invite_joiners > 0 &&
    proof.default_channels === DEFAULT_CHANNELS.length &&
    proof.membership_pairs === expectedPairs &&
    proof.snapshots_include_joiners &&
    proof.private_channel &&
    proof.private_snapshot;

  console.log(JSON.stringify({ ...proof, ok }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`verification failed: ${error.code ?? error.name}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
