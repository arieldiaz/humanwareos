# __INSTANCE_NAME__

This private repository configures one Humanware OS installation. Reusable behavior belongs in the Humanware OS framework; memory and work belong under `__DATA_ROOT__`; generated runtime belongs under `__RUNTIME_ROOT__`.

Source boundaries and update flow are defined by the Humanware OS framework; each runtime build records the framework revision it used.

This starter is generated from `humanwareos/templates/instance`. Prefer the Humanware installer when creating a real instance because it resolves the placeholder name and absolute data, runtime, and worktree paths before the first commit. A copy made with GitHub's template button requires those `__PLACEHOLDER__` values to be replaced before validation.

The instance contains no secret values. Channel, provider, and service credentials are referenced by provider and key identifier only.

This repository also owns the local server's selections and host-specific configuration: enabled services, LaunchAgent choices, Caddy routes, ports, absolute host paths, and secret-key references. Reusable service implementations and deployment mechanics stay in Humanware OS. OpenClaw uses its native gateway service and can be upgraded without reinstalling or restarting unrelated local services.

`openclaw/config.patch.json5` is the only OpenClaw-specific overlay. Humanware renders it with the profile and Slack declarations. Instance `ops/` is not a runtime input; local-server configuration is assembled at stable runtime paths for launchd.
