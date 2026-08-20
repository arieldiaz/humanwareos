#!/usr/bin/env bash
# Transcribe (runs ON THE MINI): pick up new audio/video in the canonical
# store, run open-source Whisper with timestamps, write markdown transcripts
# into the external data plane's derived/ with provenance headers.
# Done-ness = transcript exists; no marker files pollute the stream.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$OPS_DIR/stream-paths.env"
source "$OPS_DIR/lib/gate.sh"

# Whisper is the hungriest thing on this machine — yield to anything live
defer_if_busy transcribe

EXT_PATTERN='^(m4a|wav|mp3|aiff|aif|flac|mov|mp4|m4v|mkv|webm|ogg|opus)$'
OUT_ROOT="$DATA_ROOT/derived/transcripts"

find "$STREAM_CANONICAL" -type f -mmin +2 ! -name ".*" -print0 |
while IFS= read -r -d '' f; do
  ext="$(printf '%s' "${f##*.}" | tr '[:upper:]' '[:lower:]')"
  [[ "$ext" =~ $EXT_PATTERN ]] || continue

  rel="${f#"$STREAM_CANONICAL"/}"
  out="$OUT_ROOT/${rel%.*}.md"
  [ -e "$out" ] && continue

  mkdir -p "$(dirname "$out")"
  tmp="$(mktemp -d)"
  # Standard whisper-CLI shape (mlx_whisper / whisper share these flags).
  # whisper.cpp users: swap this line for e.g.
  #   whisper-cli -m "$WHISPER_MODEL" -f "$f" -osrt -of "$tmp/out"
  if ! "$WHISPER_CMD" "$f" --model "$WHISPER_MODEL" \
        --output-dir "$tmp" --output-format srt >/dev/null 2>&1; then
    echo "$(date '+%F %T') FAILED: $rel" >&2
    rm -rf "$tmp"
    continue
  fi

  srt="$(find "$tmp" -name '*.srt' | head -1)"
  [ -n "$srt" ] || { rm -rf "$tmp"; continue; }

  {
    printf -- '---\n'
    printf 'derived_from: stream://%s\n' "$rel"
    printf 'derived_at: %s\n' "$(date +%F)"
    printf 'derived_by: %s (%s)\n' "$WHISPER_CMD" "$WHISPER_MODEL"
    printf 'derived_where: local\n'
    printf 'derivation: transcript\n'
    printf -- '---\n\n'
    # srt blocks → "[HH:MM:SS] text" lines
    awk 'BEGIN{RS="";FS="\n"}
         NF>=3 {
           split($2, t, " --> "); sub(/,[0-9]+$/, "", t[1])
           printf "[%s]", t[1]
           for (i=3; i<=NF; i++) printf " %s", $i
           print ""
         }' "$srt"
  } > "$out"

  rm -rf "$tmp"
  echo "$(date '+%F %T') transcribed: $rel -> ${out#"$DATA_ROOT"/}"
done
