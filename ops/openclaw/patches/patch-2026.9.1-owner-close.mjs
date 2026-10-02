import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveSlackRuntimeModule} from '../plugins/run-signature/index.js';

// Authenticated raw Slack messages reach the plugin's owner-close check before
// mention gating. Without a loaded plugin the message falls through to stock
// handling; a plugin mismatch must never become a Slack ingress outage. The
// symbol name predates this patch and stays stable so installed bundles remain
// idempotent.
export function patchSlackCloseBoundary(source) {
  const anchor = '\tconst { senderId, allowFromLower } = authorization;';
  const failClosed = '\tif (!closeOwner?.slackClose) throw new Error("Host closure owner is unavailable");\n\tif (await closeOwner.slackClose(';
  const after = `${anchor}
	// humanware:owner-close-before-admission
	const closeOwner = globalThis[Symbol.for("humanware.final-envelope.v1")];
	if (closeOwner?.slackClose && await closeOwner.slackClose({message, accountId: account.accountId})) return null;`;
  if (source.includes(after)) return source;
  if (source.includes(failClosed)) return source.replace(failClosed, '\tif (closeOwner?.slackClose && await closeOwner.slackClose(');
  if (source.split(anchor).length !== 2) throw new Error('Slack authenticated raw-message boundary changed');
  return source.replace(anchor, after);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const slack = process.env.OPENCLAW_SLACK_PIPELINE || resolveSlackRuntimeModule('pipeline');
  const source = fs.readFileSync(slack, 'utf8');
  const next = patchSlackCloseBoundary(source);
  if (source !== next) fs.writeFileSync(slack, next);
  console.log(JSON.stringify({slack: source === next ? 'checked' : 'patched'}));
}
