# Artifact registry

An artifact registry gives a life-os instance one private, project-oriented library for outputs that need a durable URL: interactive HTML, demo video, PDFs, images, decks, and arbitrary files.

## URL contract

The private copy is canonical:

```text
https://<private-host>/artifacts/<project>/<artifact>/
```

Publishing is additive. It creates or updates a public mirror at the identical path:

```text
https://<public-host>/artifacts/<project>/<artifact>/
```

The private copy remains after publication and is the only place where editing and publishing controls appear. Never treat publication as a move or make the public repository the source of record.

Use the repository name as the project key when one exists. Otherwise use the owning work channel. Artifact identifiers begin with `YYYY-MM-DD-iter-NN`; add a short type or purpose suffix only when multiple artifacts belong to the same iteration.

## Artifact model

Every artifact has `project`, `id`, `title`, `date`, optional `iteration`, `type`, private source location, and publication state. Start with three types: `html`, `video`, and `file`. Shared metadata and project pages stay type-agnostic; renderers differ by type.

## Publishing contract

The private artifact page may expose a **Publish to www** action. It validates slugs and resolved roots, rejects symlinks and private references, copies a self-contained artifact to the public repository at the same relative path, strips private-only controls, commits and pushes, then waits for the public host to serve a marker unique to that publish.

Publishing is a state machine: preflight → commit → push → deploy → live or error. The private page polls an inline status endpoint and shows the public link only in the live state. A successful Git push is not deployment proof.

Keep repository credentials on the server. The browser calls a tailnet-only publisher endpoint and never receives a token. Require explicit confirmation because the resulting URL is public.

## Compatibility

A migration from another archive preserves old URLs as aliases or redirects. Producers may continue writing the old shape during a transition; the registry absorbs completed outputs rather than forcing every active agent to switch paths mid-run.
