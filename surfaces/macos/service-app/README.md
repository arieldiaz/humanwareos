# Service app

One signed app bundle owns an instance's background jobs, so macOS lists them under the app's name instead of `sh` or `python3`, and holds the app responsible for them.

`build.sh NAME BUNDLE_ID SIGNING_IDENTITY OUTPUT.app` compiles `launcher.c` into `OUTPUT.app/Contents/MacOS/NAME`, signs the bundle with hardened runtime, and verifies it. `-` signs ad hoc for tests; there is no default identity. An unchanged rebuild leaves the installed bundle untouched.

A job runs `NAME run <service> -- <command> [args...]` and sets `AssociatedBundleIdentifiers` to the bundle identifier. The launcher spawns the command as a child rather than `exec`, so the signed app stays the parent; it forwards SIGTERM, SIGINT and SIGHUP, waits for the child, and exits with its status (128+signal on signal death).

`tests/service-app.sh` exercises both.
