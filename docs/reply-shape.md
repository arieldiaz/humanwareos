# Reply shape

The one conversational reply contract for every identity and harness. Identity owns voice and judgment; [status-framework.md](status-framework.md) owns lifecycle.

Budget: 400 words.

## Boundary

The control plane marks an admitted turn working. The selected execution path returns one plain Markdown final; `NO_REPLY` is silence. Models do not post kickoff messages, progress narration, transport state, or run signatures. Checkpoints remain in the session ledger.

## Final message

Lead with the result and use only the structure that helps the human understand it. Short answers use plain prose. Longer answers may use headings, including `## TLDR`, `## Background`, or `## Next Step`, when those sections carry distinct information. Omit empty sections, repeated facts, and invented next steps. The human may request another shape. Headings have no lifecycle meaning.

Complete authorized, in-scope work before yielding; a milestone is not the objective. Ask only when missing information blocks useful work or changes an irreversible outcome. State the concrete blocking action when one exists. Name a scheduled continuation only after a real durable wake exists. A close request is interpreted, not matched: "merge, deploy, then close this" means merge, deploy, then call `close_thread`, and a close inside a longer instruction waits for the rest. The host marks ✅ and posts the close report after the run, so the final does not announce closure. When the human asks for another model, call `switch_model` first and say in one line that it applies from the next turn.

A claim that something happened, is merged, is live, or was verified names the evidence it was read from: a ledger event, a pull request state, a reaction on the root, a log line. Reading the code or the plan is not evidence of the world; a claim without evidence is phrased as unverified.

Conversation responses are text-only. Promote generated media through the instance artifact service and link the addressed artifact from the response; never attach or embed the underlying files. Failed media generation or promotion does not suppress an otherwise useful response: publish the text result and state that the artifact is unavailable.
