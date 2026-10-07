import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {digest, ownerSessionRequest, splitOwnerText} from './framework.mjs';
const exec = promisify(execFile);

export async function gatewayCall(method, params) {
  // CLI resolves gateway credentials through the existing protected configuration.
  // No credential or email body is put in argv or returned in diagnostics.
  try {
    const {stdout} = await exec(process.env.OPENCLAW_BIN ?? 'openclaw', ['gateway', 'call', method, '--params', JSON.stringify(params), '--json', '--timeout', '15000'], {timeout: 20000, maxBuffer: 1024 * 1024});
    return JSON.parse(stdout);
  } catch { throw new Error('gateway_dispatch_unconfirmed'); }
}

export class SessionAdapter {
  constructor({store, directory, call = gatewayCall}) { Object.assign(this, {store, directory, call}); }
  async verify() {
    const result = await this.call('health', {});
    if (result.ok !== true) throw new Error('gateway_unavailable');
  }
  async dispatch(effect, conversation, evidence) {
    const previous = this.store.delivery(effect.key);
    if (previous?.result) return previous.result;
    // RPC idempotency alone is not guaranteed across gateway restarts. An unknown
    // admission is held for operator reconciliation, never blindly re-executed.
    if (previous) {
      const observed = await this.call('agent.wait', {runId: effect.key, timeoutMs: 1});
      if (observed.runId === effect.key && observed.status === 'ok') {
        const params = ownerSessionRequest({conversation, effect, requestPath: join(this.directory, digest(effect.key), 'request.json')});
        const result = {sessionKey: params.sessionKey, runId: effect.key, accepted: true, reconciled: true};
        this.store.confirmed(effect.key, result);
        return result;
      }
      throw new Error('ambiguous_session_admission');
    }
    const directory = join(this.directory, digest(effect.key));
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const attachments = (evidence.attachments ?? []).map((a, i) => {
      const path = join(directory, `attachment-${i}`);
      if (!existsSync(path)) writeFileSync(path, Buffer.from(a.content, 'base64'), {mode: 0o600, flag: 'wx'});
      return {name: a.name, mimeType: a.mimeType, path, authority: 'untrusted-context'};
    });
    const requestPath = join(directory, 'request.json');
    if (!existsSync(requestPath)) writeFileSync(requestPath, JSON.stringify({
      ...splitOwnerText(evidence.textBody, {htmlOnly: evidence.htmlOnly}),
      authenticatedPrincipal: evidence.authentication.principal,
      subject: evidence.message.subject, attachments,
    }), {mode: 0o600, flag: 'wx'});
    const params = ownerSessionRequest({conversation, effect, requestPath});
    this.store.start(effect.key);
    const result = await this.call('agent', params);
    if (result.runId !== effect.key || !['accepted', 'ok'].includes(result.status)) throw new Error('gateway_admission_missing');
    const confirmed = {sessionKey: params.sessionKey, runId: result.runId, accepted: true};
    this.store.confirmed(effect.key, confirmed);
    return confirmed;
  }
}
