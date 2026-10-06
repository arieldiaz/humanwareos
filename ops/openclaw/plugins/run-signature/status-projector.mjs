import {normalizeReactions, planStatusTile, resolveStatusTile} from "./strip-core.mjs";

function tolerantWrite(task) {
  return task().catch((error) => {
    if (/already_reacted|no_reaction/.test(String(error))) return;
    throw error;
  });
}

export function createStatusProjector(api, {
  appendFaultJournal,
  botIdCache,
  resolveBotUserId,
  resolveSlackRuntimeModule,
  retrySlackRateLimit,
  serialize,
}) {
  const faultedRoots = new Set();
  const journalFault = async (channel, rootTs, reason) => {
    faultedRoots.add(`${channel}:${rootTs}`);
    await appendFaultJournal({channel, rootTs, reason});
  };
  const journalRecovery = async (channel, rootTs) => {
    const key = `${channel}:${rootTs}`;
    if (!faultedRoots.delete(key)) return;
    await appendFaultJournal({channel, rootTs, recovered: true});
  };

  return async function maintainStatusTile(outboundStatus, ctx, {channel, rootTs, routeKey, accountId, token}) {
    await serialize(routeKey, async () => {
      const actions = await import(resolveSlackRuntimeModule("actions"));
      const accounts = await import(resolveSlackRuntimeModule("accounts"));
      const call = (task) => retrySlackRateLimit(task);
      const opts = {cfg: api.config, accountId, token};
      const sendingBotId = ctx.botUserId ?? await resolveBotUserId(token, botIdCache);
      if (!sendingBotId) {
        api.logger?.error?.(`run-signature could not resolve its own bot user id for ${routeKey}; status tile left untouched`);
        await journalFault(channel, rootTs, "the bot's own user id could not be resolved, so the status tile was left untouched");
        throw new Error("Lifecycle projection could not resolve its sending identity");
      }
      const accountIds = [...new Set([accountId, ...Object.keys(api.config?.channels?.slack?.accounts ?? {})].filter(Boolean))];
      const fleet = new Map([[sendingBotId, {accountId, token}]]);
      for (const id of accountIds) {
        const candidate = accounts.resolveSlackAccount({cfg: api.config, accountId: id})?.botToken;
        if (!candidate) continue;
        const userId = await resolveBotUserId(candidate, botIdCache);
        if (userId && !fleet.has(userId)) fleet.set(userId, {accountId: id, token: candidate});
      }
      const botUserIds = new Set(fleet.keys());
      const optsFor = (holder) => {
        const entry = fleet.get(holder);
        return entry ? {cfg: api.config, accountId: entry.accountId, token: entry.token} : opts;
      };
      try {
        const observed = normalizeReactions(await call(() => actions.listSlackReactions(channel, rootTs, opts)));
        const lifecycle = resolveStatusTile(outboundStatus, observed, botUserIds);
        const plan = planStatusTile(observed, {lifecycle, sendingBotId, botUserIds});
        for (const {name, holders} of plan.remove) {
          for (const holder of holders) await tolerantWrite(() => call(() => actions.removeSlackReaction(channel, rootTs, name, optsFor(holder))));
        }
        for (const {name, holders} of plan.add) {
          for (const holder of holders) await tolerantWrite(() => call(() => actions.reactSlackMessage(channel, rootTs, name, optsFor(holder))));
        }
        await journalRecovery(channel, rootTs);
      } catch (error) {
        api.logger?.error?.(`run-signature status tile failed for ${routeKey}: ${String(error)}`);
        await journalFault(channel, rootTs, String(error?.message ?? error));
        throw error;
      }
    });
  };
}
