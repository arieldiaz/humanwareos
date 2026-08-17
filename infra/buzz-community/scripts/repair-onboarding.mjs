import pg from "pg";

const { Client } = pg;
const APPLY = process.argv.includes("--apply");
const COMMUNITY_HOST = "community.humanwareos.com";
const DEFAULT_CHANNELS = ["general", "welcome-everyone", "bugs"];
const PRIVATE_CHANNEL = "agent-testing";

if (!process.env.BUZZ_COMMUNITY_DATABASE_URL) {
  console.error("repair failed: BUZZ_COMMUNITY_DATABASE_URL is unavailable");
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.BUZZ_COMMUNITY_DATABASE_URL,
  statement_timeout: 15_000,
  query_timeout: 20_000,
});

try {
  await client.connect();
  await client.query("BEGIN");

  const community = await client.query(
    "SELECT id FROM communities WHERE host = $1",
    [COMMUNITY_HOST],
  );
  if (community.rowCount !== 1) {
    throw new Error("community host did not resolve exactly once");
  }
  const communityId = community.rows[0].id;

  const defaults = await client.query(
    `SELECT id, name
     FROM channels
     WHERE community_id = $1
       AND name = ANY($2)
       AND visibility = 'open'
       AND archived_at IS NULL
       AND deleted_at IS NULL
     ORDER BY name`,
    [communityId, DEFAULT_CHANNELS],
  );
  if (defaults.rowCount !== DEFAULT_CHANNELS.length) {
    throw new Error("default public channels are missing or not open");
  }

  const privateChannel = await client.query(
    `UPDATE channels
     SET visibility = 'private', updated_at = now()
     WHERE community_id = $1
       AND name = $2
       AND archived_at IS NULL
       AND deleted_at IS NULL
     RETURNING id`,
    [communityId, PRIVATE_CHANNEL],
  );
  if (privateChannel.rowCount !== 1) {
    throw new Error("agent-testing did not resolve exactly once");
  }

  const joiners = await client.query(
    `SELECT pubkey
     FROM relay_members
     WHERE community_id = $1
       AND role = 'member'
       AND added_by = 'invite'
     ORDER BY created_at`,
    [communityId],
  );

  const repaired = await client.query(
    `INSERT INTO channel_members
       (community_id, channel_id, pubkey, role, invited_by)
     SELECT $1, channel.id, decode(member.pubkey, 'hex'), 'member', NULL
     FROM unnest($2::uuid[]) AS channel(id)
     CROSS JOIN unnest($3::text[]) AS member(pubkey)
     ON CONFLICT (community_id, channel_id, pubkey) DO UPDATE SET
       removed_at = NULL,
       removed_by = NULL,
       role = CASE
         WHEN channel_members.removed_at IS NULL THEN channel_members.role
         ELSE 'member'::member_role
       END
     RETURNING channel_id`,
    [
      communityId,
      defaults.rows.map((row) => row.id),
      joiners.rows.map((row) => row.pubkey),
    ],
  );

  if (APPLY) {
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }

  console.log(
    JSON.stringify({
      mode: APPLY ? "applied" : "dry-run",
      invite_joiners: joiners.rowCount,
      default_channels: defaults.rowCount,
      membership_pairs: repaired.rowCount,
      private_channels: privateChannel.rowCount,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`repair failed: ${error.code ?? error.name}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
