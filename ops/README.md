# ops/ — the stream pipeline

For project-oriented HTML, video, and file outputs, see the private-to-public mirror pattern in [docs/artifact-registry.md](../docs/artifact-registry.md). A reference tailnet-only publisher lives at `ops/artifacts/publisher.py`; instances provide roots, hostnames, private-marker rules, and service wiring.

Capture → sync → transcribe → backup, all local. MacBook records, mini keeps and computes, NAS archives. See [STREAM.md](../STREAM.md) for the architecture; this is the setup guide.

**These scripts are a working first draft** — written blind against your machines. Test each stage with junk files before trusting it with real life. The delete-from-MacBook step in particular: run it a few times watching both ends.

## What you customize vs. what's framework

One rule, so a new user always knows what's theirs to touch:

**`ops/stream-paths.env` is the entire customization surface.** Everything you'd ever change — paths, hostnames, which recording folders, backup repos, performance-gate thresholds — lives in that one file. It's gitignored, so your machine's reality never collides with the framework.

**Everything else in `ops/` is framework** — the scripts (`macbook/`, `mini/`), shared logic (`lib/`), and the launchd plists. You don't edit these; they read their values from `stream-paths.env`. Mechanism lives in the framework; policy lives in your one config file.

The teaching tool is the pairing: every real file has an `.example` twin (`stream-paths.env.example`, `backup/exclude.txt.example`), and the twin's inline comments ARE the docs for every knob. To see everything a fresh instance customized, diff its `stream-paths.env` against the `.example` — that diff is the whole customization. (A private instance like `ariel-os` is exactly this: this framework, plus its own `stream-paths.env` and a couple of gitignored data files.)

## Backup: 3-2-1 with restic

Layered on the pipeline above; all three copies use the same restic repo format, so a restore is identical wherever you pull from.

| Copy | Where | Cadence | What |
|------|-------|---------|------|
| 1 — laptop → mini | MacBook, `backup-to-mini.sh` | daily 3am | MacBook-only config/dotfiles + a fresh Brewfile → SFTP repo on the always-on mini. Gated: never runs while recording/on battery. |
| 2 — mini → SSD | mini, `backup-to-ssd.sh` | monthly, manual | Mini's canonical data → external SSD. A cron reminder nags you to plug it in. |
| 3 — mini → QNAP | mini, `backup-to-nas.sh` | nightly (when NAS online) | Bulk/video archive to RAID. |

Setup: put the repo passphrase in each machine's Keychain (`security add-generic-password -a "$USER" -s lifeos-restic -w`), fill the `# Backup (restic)` block in `stream-paths.env`, copy `backup/exclude.txt.example` → `backup/exclude.txt`, then load `com.lifeos.backup.plist` on the MacBook. Restore anytime with `restic -r <repo> restore latest --target /tmp/restore`.

## One-time setup

### Config (both machines)

```bash
cp ops/stream-paths.env.example ops/stream-paths.env
# edit paths, hostnames, capture dirs — this file is gitignored
chmod +x ops/macbook/*.sh ops/mini/*.sh

# the plists ship with /Users/you placeholders — point them at your account:
LC_ALL=C sed -i '' "s|/Users/you|/Users/$USER|g" ops/macbook/*.plist ops/mini/*.plist
```

### MacBook

1. **SSH to the mini without a password:** `ssh-keygen -t ed25519` (if needed), then `ssh-copy-id you@mini.local`. Verify `ssh mini.local true` returns silently.
2. **Point recorders at a capture dir.** Everything you record on the computer should land in one of `CAPTURE_DIRS` — QuickTime's save location, your screen-record folder, your dictation app's "save audio" folder. If an app insists on its own location, add that location to `CAPTURE_DIRS` instead of fighting it.
3. **Install the agents** (edit repo paths in the plists first if yours differs):

```bash
cp ops/macbook/com.lifeos.{ingest,sync}.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.lifeos.ingest.plist
launchctl load ~/Library/LaunchAgents/com.lifeos.sync.plist
```

### Mac mini

1. **Whisper:** `pip install mlx-whisper` (Apple Silicon; needs `brew install ffmpeg`). First run downloads the model. Alternatives (openai-whisper, whisper.cpp) work — adjust `WHISPER_CMD` and, if needed, the one command line in `transcribe-watch.sh`.
2. **Repo on the mini too:** clone the repo so transcripts land in its `derived/` (git is how derived text gets back to the MacBook — commit/pull, or sync the folder however you sync the vault).
3. **Install the agents:**

```bash
cp ops/mini/com.lifeos.{transcribe,nasbackup}.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.lifeos.transcribe.plist
launchctl load ~/Library/LaunchAgents/com.lifeos.nasbackup.plist
```

4. **QNAP:** mount the backup share at `NAS_BACKUP_DIR` (Finder → ⌘K → `smb://qnap.local/...`, then add to Login Items so it remounts). On the QNAP itself: enable scheduled snapshots on the share. Ethernet to the mini, as planned — transcription doesn't care, but backup of video will.

## How it flows

| Stage | Where | Cadence | What |
|-------|-------|---------|------|
| Ingest | MacBook | 2 min | New A/V in capture dirs → `$STREAM_LOCAL/YYYY/MM/DD/HHMM-slug.ext`. Skips files still being written. |
| Sync | MacBook | 5 min | Spool → mini, checksum-verified, **then deleted from MacBook**. Mini offline? Spool waits; nothing lost. |
| Transcribe | mini | 5 min | New A/V → Whisper → `derived/transcripts/.../HHMM-slug.md`, timestamped lines + provenance header. Done-ness = transcript exists. |
| Backup | mini | nightly 03:30 | Canonical store → NAS, no `--delete` ever. |

## Performance: the pipeline never fights the human

Two mechanisms keep background work invisible, both on by default:

**QoS.** Every plist runs its job as `ProcessType: Background` with `LowPriorityIO` — on Apple Silicon that means efficiency cores and throttled disk, so the OS itself deprioritizes the pipeline whenever anything interactive wants the machine. Transcription gets slower; nobody is waiting on it.

**The gate.** Heavy jobs (sync, transcribe, backup) source `lib/gate.sh` and exit early — deferring to a later launchd tick — when the machine is busy: OBS running, user active in the last 5 minutes, or on battery. Because every job is interval-based and idempotent, deferring costs nothing; the spool holds, the work happens on the next quiet tick. Sync additionally caps its upload at `SYNC_BWLIMIT` (default 8 MiB/s) so a multi-GB recording can't starve a live stream's bitrate even when it does run. Tune or disable any gate in `stream-paths.env` — knobs documented in `stream-paths.env.example`.

The design principle: never kill, defer. Pausing new work is free and resumable; killing running work risks half-written state.

## Live sessions vs. the archive

This pipeline is the *archive* path. For **live** voice during sessions (dictating to an agent, live meeting transcription), use whatever tool feels best in the moment — the only rule is its audio artifact must also land in a `CAPTURE_DIRS` folder, so the archive path picks it up regardless. Live use and archival capture are two consumers of the same recording, not two recordings.

## Debugging

Logs: `~/Library/Logs/lifeos-*.log` on each machine. Kick a job manually: `launchctl start com.lifeos.sync`. Common gotchas: launchd needs Full Disk Access for bash/scripts touching protected folders (System Settings → Privacy & Security); `mlx_whisper` not found under launchd → the PATH line in the transcribe plist covers homebrew/pip defaults, extend it if your install lives elsewhere.
