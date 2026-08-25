# STREAM.md — append-only evidence in the data plane

The stream lives under the external data root declared by the private instance. It never lives in Humanware OS, the private instance repository, or a generated runtime. This file is the reusable contract; the instance chooses actual paths, capture devices, retention, and backup targets.

## Shape

```text
$HUMANWARE_DATA_ROOT/stream/YYYY/MM/DD/HHMMSS-short-slug.ext
$HUMANWARE_DATA_ROOT/stream/YYYY/MM/DD/HHMMSS-short-slug.md
```

The stream is the rawest durable evidence available: recordings, photos, screenshots, imported messages, meeting exports, documents as received, URLs with captured content, and decisions as made. A sidecar may add provenance and context without modifying the event.

## Rules

1. Append events; do not edit, rename, or overwrite them. A correction is a new event that names the earlier event.
2. Preserve the rawest available form. Derivations never replace their source.
3. Use time plus a short slug, not a permanent taxonomy. Current indexes belong under `generated/` or `current/memory/`.
4. Every ingest records source, capture time, ingest time, checksum, privacy tier, and the mechanism that wrote it.
5. Tier 0 evidence remains on approved local infrastructure. A cloud harness receives only a deliberately scoped derivative or explicitly supplied item.
6. Credentials never enter the stream. If one does, delete that exact event, record a non-secret correction event, and rotate the credential. This is the one exception to append-only retention.

Capture paths must support an excluded private area and a filename marker such as `noarchive` so sensitive material can be kept outside ingest.

## Projections and artifacts

Transcripts, summaries, indexes, and reports belong under `$HUMANWARE_DATA_ROOT/generated/`. Each carries source identifiers, creation time, model or tool, schema version, and privacy scope. They are replaceable.

Curated facts and decisions are appended under `evidence/memory/events/`, then merged into compact files under `current/memory/`. Strategy has the same split between evidence and current projection. Working documents live under `working/<owner>/` with version history. Published or reviewable revisions live under `artifacts/` and are immutable once addressed.

## Durability

The canonical data root needs at least three copies across two media, with one offsite or offline. Backup is not complete until a restore to a new location passes checksums and a representative application can read the result. Source-repository history is not a backup for the data plane.
