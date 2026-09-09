// Normalize both supported OpenClaw roster layouts without changing their policy.
export function readAgentEntries(config) {
  const agents = config?.agents;
  if (agents?.entries != null && agents?.list != null) throw new Error("config must not define both agents.entries and agents.list");
  const keyed = agents?.entries != null;
  if (keyed && (typeof agents.entries !== "object" || Array.isArray(agents.entries))) throw new Error("agents.entries must be an object");
  const entries = keyed ? Object.entries(agents.entries) : (Array.isArray(agents?.list) ? agents.list.map((entry) => [entry?.id, entry]) : []);
  if (entries.length === 0) throw new Error("config agents.entries or agents.list must be non-empty");
  const ids = new Set();
  for (const [id, entry] of entries) {
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`unsafe agent id ${String(id)}`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`agent ${id} must be an object`);
    if (keyed && Object.hasOwn(entry, "id")) throw new Error(`agent ${id} must use its entries key, not an id field`);
    if (ids.has(id)) throw new Error(`duplicate agent id ${id}`);
    ids.add(id);
  }
  return {keyed, entries};
}
