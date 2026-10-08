# Private share authentication

Loopback-only authentication for private artifact shares. Recipient grants use one-use magic links (default 15 minutes) and Secure, HttpOnly, SameSite=Lax sessions (default eight hours). SQLite stores SHA-256 digests only. Revoking a grant immediately invalidates its sessions. Request logs are disabled so redemption credentials never enter logs.

Only `/auth/redeem` should be exposed on the public share hostname; `/admin/invite` and `/admin/revoke/<id>` stay on loopback. `/auth/check` is a forward-auth endpoint reading `X-Original-URI`. An invite POST emails its recipient (via Resend), so callers must have explicit authorization to send. Grants accept exact `/artifacts/<slug>/<slug>/` paths only. Missing `RESEND_API_KEY` disables delivery, not authentication; `/health` reports only whether delivery is configured.

Configuration (environment):

| Variable | Required | Meaning |
| --- | --- | --- |
| `SHARE_AUTH_ORIGIN` | yes | Public origin used in magic links |
| `SHARE_AUTH_MAIL_FROM` | yes | Verified sender for link mail |
| `SHARE_AUTH_DB` or `HUMANWARE_DATA_ROOT` | yes | DB path, default `<data>/operations/control/share-auth/auth.sqlite3` |
| `RESEND_API_KEY` | no | Enables delivery |
| `SHARE_AUTH_BIND` | no (`127.0.0.1:8792`) | Listen address |
| `SHARE_AUTH_LINK_TTL` / `SHARE_AUTH_SESSION_TTL` | no (900 / 28800) | Seconds |
| `SHARE_AUTH_MAIL_SUBJECT` | no | Link mail subject |
| `SHARE_AUTH_RESOURCE_ALIASES` | no | `prefix=grant,...`; requests under `prefix` require the exact `grant` |
| `SHARE_AUTH_AUTHORIZED_HEADERS` | no | `Header=value,...` returned on a successful `/auth/check` |

Tests: `python3 -m unittest discover -s services/share-auth -p "test_*.py"`.
