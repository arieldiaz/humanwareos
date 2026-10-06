export const PACK_SIZE = 15;
export const KEEP_THRESHOLD = 0.25;

// Scored keeps first, then unscored (fail keep), then scored drops. Search rank breaks ties.
function tier(score, threshold) {
  if (score?.status === "scored") return score.p >= threshold ? 0 : 2;
  return 1;
}

export function buildPack({candidates, scores, size = PACK_SIZE, threshold = KEEP_THRESHOLD}) {
  const rows = candidates.map((doc, rank) => ({doc, rank, score: scores.get(doc._id) ?? {p: null, status: "unscored", reason: "missing"}}));
  rows.forEach((row) => (row.tier = tier(row.score, threshold)));
  rows.sort((a, b) => a.tier - b.tier || (a.tier === 0 ? b.score.p - a.score.p : 0) || a.rank - b.rank);
  const kept = rows.filter((row) => row.tier < 2).slice(0, size);
  const keptIds = new Set(kept.map((row) => row.doc._id));
  return {
    kept: kept.map(({doc, rank, score}) => ({...summarize(doc), searchRank: rank + 1, p: score.p, status: score.status})),
    dropped: rows.filter((row) => !keptIds.has(row.doc._id)).map(({doc, rank, score}) => ({id: doc._id, searchRank: rank + 1, p: score.p, status: score.status, ...(score.reason ? {reason: score.reason} : {})})),
  };
}

export function summarize(doc) {
  return {id: doc._id, kind: doc.kind, date: doc.meta?.date ?? doc.meta?.created ?? null, title: doc.title};
}
