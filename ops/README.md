# Reusable operations

This directory contains framework mechanisms for capture, sync, derivation, backup, health checks, and host services. It contains no hostnames, usernames, domain names, credentials, personal paths, or mutable outputs.

The private instance supplies typed configuration. Generated launchd jobs and service files are written into an immutable runtime build. Logs, state, captures, derived outputs, and backup metadata go to the external data plane or the host's standard log directories.

## Operating rules

- A daemon reads configuration through the active runtime `current` symlink, never from a Git checkout.
- A host path appears only in private instance configuration and generated output.
- Credentials are hydrated at launch from the configured secrets provider. Secret values never appear in a plist, source file, or generated manifest.
- Jobs wait for required network, DNS, mounts, and upstream health before starting dependent work.
- Restart policies are bounded and observable. A crash loop becomes a failed health state rather than silent repeated execution.
- Every write is idempotent or append-only. A transfer that deletes a spool item verifies the destination checksum first.
- Backup is verified by restore, not by process exit.

`ops/stream-paths.env.example` remains a legacy compatibility example while stream mechanisms move to typed instance configuration. Do not copy it into the framework checkout with real values.
