# Artifact service

`artifact_manager.py` is the only writer of the artifact registry, the immutable revision store, and the generated review projection under the instance data root. `publisher.py` mirrors an artifact's live content to the public site repository on request with an `artifact-publish.json` marker (`shell: "site"`, the live `version` number, `history_url`); the site build owns the public shell and footer. The model and URLs are in [`docs/versioning.md`](../../docs/versioning.md).

In an assembled runtime both run from `<runtime>/current/framework/ops/artifacts/` and read the data root from `config/instance.json`. The instance supplies `config/services/artifacts.json` (`listen`, `publicOrigin`, `publicRepo`, `privateMarkers`, `legacyRoot`), its launchd and Caddy wiring, and optionally `surface/artifacts/theme.css`.

Promote a staged directory as the working session's artifact. The first promotion in a session creates artifact N; every later one in that session is its next version. The command prints the live URL.

```text
/usr/bin/python3 "<runtime>/current/framework/ops/artifacts/artifact_manager.py" create --source <STAGED_DIRECTORY> --project <PROJECT_SLUG> --project-name <PROJECT_NAME> --session <SESSION_KEY> --title <TITLE> --date <DATE_LABEL>
```

Never write the revision store, registry, or projection by hand. Verify the store and projection with `artifact_manager.py verify`, and rebuild the projection with `rebuild`.

`migrate --sessions <FILE>` converts a pre-schema-3 registry: it groups revisions strictly by creating session (`{"<project>/<revision>": "<session>"|null}`), numbers artifacts and versions by date, keeps old addresses as redirects, and prints the plan with the current registry checksum. It writes only with `--write`; rehearse against a copied store first.
