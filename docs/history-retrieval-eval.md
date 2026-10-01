# History retrieval benchmark

Measures whether Jev filtering beats local search for "Ask the history" on effectiveness, speed, and cost. `docs/history-retrieval.md` owns retrieval, privacy, and sources; this file owns only the benchmark.

Budget: 650 words. Over it, consolidate.

## Question

For goals with known answers, does a Jev pack keep needed evidence as reliably as search, more precisely, at acceptable latency and cost? The benchmark is read-only and off every production path.

## Arms

Each goal's top 200 candidates are captured once per run and shared by every arm.

- **S, search-only:** the first 15 candidates, with no egress.
- **J, Jev-filtered:** metadata egress (option B), the 15 highest keep-probabilities, and fail keep.
- **J+summary, optional:** J plus an agent-written one-line session summary supplied by a source adapter. Raw conversation text, excerpts, and text mechanically derived from them never qualify. It runs only when the owner selects it for a run; metadata stays the default, and adopting it first requires amending the retrieval spec's privacy section.

## Goal set

Goals and labels are private data in `$HUMANWARE_DATA_ROOT/working/ask-history/goals.json`, never in source. Each goal has text, `critical` ids that must appear in the pack, `relevant` ids, and optional `superseded` ids that should not be packed. The set includes:

- about five precedent-decision goals answered by recorded pull requests and decisions; for example, the Slack reply-shape goal must surface PR #32, "Fix Slack reply shape";
- the session-completion goal, "What must an agent know before changing session completion behavior?" Its critical ids are the change, the later correction, the deployed fix, and the record distinguishing merged from deployed;
- the personal-commitments goal;
- the runtime-PR goal.

Labels are frozen before a run; the receipt records the file hash. Each unlabeled packed id is judged once, blind to arm, as `relevant`, `partial`, or `not`, and appended. Agent labels stay marked until the owner reviews them. A goal used for tuning leaves the gating set.

## Metrics

For each goal and arm:

- **Recall:** packed fraction of critical ids, and of critical plus relevant ids.
- **Critical misses:** each absent critical id with its cause: not a candidate (search ceiling), unscored overflow, or ranked out.
- **Precision:** relevant packed ids ÷ pack size; partial counts half, superseded zero.
- **Threshold sensitivity:** J re-packed from the same scores at 0.25 (default), 0.4, and 0.5, with pack size, recall, and precision; no extra requests.
- **Stability:** mean pairwise Jaccard overlap of J's packs across repeats.
- **Latency:** wall-clock search and Jev time per pack; nearest-rank p50 and p95.
- **Cost:** provider-reported input and output tokens, dollars, requests, failed requests, unknown-usage requests, and unscored candidates by reason, including overflow.

Unknown usage is unknown, never zero. Under 20 samples, p95 is the maximum.

## Gate

J may become an optional pre-work context pack, never automatic compaction, only if across the gating set it has zero critical misses, recall no lower than S, precision above S, p95 added latency ≤ 10 s, and cost ≤ $0.005 per pack.

S remains the fallback whenever Jev is unavailable. Production wiring requires separate approval.

## Adapter parity

When the Activity adapter exists, the goal set runs against it and the interim adapter. It replaces the interim readers only if neither S nor J recall falls; otherwise the missing field, most likely host-only text for local search, must come from the Activity source, not a side reader.

## Receipts

Each run writes `$HUMANWARE_DATA_ROOT/generated/reports/ask-history/<run-id>/` with these files:

- `run.json`: the goal-file hash, commit, model, limits, thresholds, repeats, adapter, and index document count;
- one file per goal, arm, and repeat with packed and dropped ids, scores, timings, and usage;
- `summary.json`: the metrics and gate result.

Receipts hold no egress text or credentials. A runner calls only the existing search, scorer, and pack functions.

## Cost estimate

Eight goals × three repeats ≈ 24 Jev packs ≈ $0.05 at the observed $0.002 per pack.
