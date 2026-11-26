# Service app

One signed app bundle owns an instance's background jobs, so macOS lists them under the app's name instead of `sh` or `python3`, and holds the app responsible for them.

`build.sh NAME BUNDLE_ID SIGNING_IDENTITY OUTPUT.app` compiles `launcher.c` into `OUTPUT.app/Contents/MacOS/NAME`, signs the bundle with hardened runtime, and verifies it. `-` signs ad hoc for tests; there is no default identity. An unchanged rebuild leaves the installed bundle untouched.

A job runs `NAME run <service> -- <command> [args...]` and sets `AssociatedBundleIdentifiers` to the bundle identifier. The launcher spawns the command as a child rather than `exec`, so the signed app stays the parent; it forwards SIGTERM, SIGINT and SIGHUP, waits for the child, and exits with its status (128+signal on signal death).

`render-jobs.py --manifest FILE --app FILE --runtime DIR --data-root DIR [--check-paths] OUTPUT_DIR` turns an instance's service manifest into those jobs: one `<labelPrefix>.<name>.plist` per service, nothing written unless the whole manifest is valid. The app setting supplies `name`, `bundleIdentifier` and `path`. The manifest is `{schemaVersion: 1, labelPrefix, services: [...]}`; each service has a `name` (`^[a-z][a-z0-9-]*$`, unique), a `command` argv in which `{runtime}` and `{dataRoot}` stand for the runtime `current` path and the data root, and exactly one `trigger`: `{"keepAlive": true}`, `{"everySeconds": N}` or `{"calendar": {...}}` (a `StartCalendarInterval` dict or list). Optional: `source` (the instance folder it belongs to), `replaces` (old labels an installer stops first), `environment`, `workingDirectory`, `throttleSeconds`, `processType` (default `Background`), `lowPriority` (nice 10 and low-priority I/O), `watchPaths` and `logs` (`stdout` and `stderr`). Every resolved path must be absolute; `--check-paths` also requires every placeholder path to exist and the program to be executable, for use on the host just before install.

`adopt-job.py` brings a job that another installer writes, such as OpenClaw's gateway, under the app: `wrap` and `unwrap` edit the job file in place (idempotent, atomic, every other key kept), `apply` wraps, reloads and health-checks it and restores the original on failure, and `launch` runs `apply` as a one-shot launchd job so it can be started from inside the job's own process tree. Its usage is in the file.

`tests/service-app.sh` exercises the bundle and launcher; `test_render_jobs.py` the generator; `test_adopt_job.py` the adopter.
