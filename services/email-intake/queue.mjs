import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync, linkSync, unlinkSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {join} from 'node:path';

// HTTP pull JSON bodies arrive serialized from the REST producer; Worker
// producers may encode JSON as base64. Accept both explicit wire representations.
export function decodeMessage(message) {
  if (message.metadata?.['CF-Content-Type'] !== 'json' || typeof message.body !== 'string' || message.body.length > 180000) throw new Error('invalid_queue_message');
  const text = message.body.trimStart();
  const event = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'));
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid_queue_message');
  return event;
}

export class QueueConsumer {
  constructor({config, token, intake, directory, fetcher = fetch, now = Date.now}) {
    if (!token || ![config.accountId, config.ingressId, config.deadLetterId].every(x => /^[a-f0-9]{32}$/.test(x))) throw new Error('queue_configuration_missing');
    Object.assign(this, {config, token, intake, directory, fetcher, now});
    this.lastSuccess = 0;
  }
  async api(queue, action, body) {
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/queues/${queue}/messages/${action}`, {
      method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${this.token}`},
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error'
    });
    if (!response.ok) throw new Error('queue_api_unavailable');
    const value = await response.json();
    if (value.success !== true) throw new Error('queue_api_unavailable');
    return value.result;
  }
  async poll(queue, deadLetter = false) {
    // One lease at a time: slow Slack/gateway work cannot expire a waiting batch.
    const result = await this.api(queue, 'pull', {batch_size: 1, visibility_timeout_ms: 300000});
    if (!Array.isArray(result?.messages)) throw new Error('invalid_queue_response');
    for (const message of result.messages) {
      if (typeof message.lease_id !== 'string' || !message.lease_id) throw new Error('invalid_queue_response');
      let confirmed = false;
      try {
        if (deadLetter) {
          // Retain even malformed envelopes before acknowledging the DLQ. Lease
          // tokens never enter evidence. Exclusive durable write survives replay.
          const key = createHash('sha256').update(JSON.stringify([queue, message.id, message.body])).digest('hex');
          mkdirSync(this.directory, {recursive: true, mode: 0o700});
          const pending = join(this.directory, `${key}.${randomUUID()}.tmp`);
          try {
            writeFileSync(pending, JSON.stringify({id: message.id, body: message.body, metadata: message.metadata}), {flag: 'wx', mode: 0o600, flush: true});
            // A crash cannot leave a partial final record that replay mistakes
            // for retained evidence. Publish atomically without overwriting.
            try { linkSync(pending, join(this.directory, `${key}.json`)); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
          } finally {
            try { unlinkSync(pending); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          const descriptor = openSync(this.directory, 'r');
          try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
          this.intake.store.fault(`queue-dlq:${key}`, 'queue_exhausted');
          confirmed = true;
        } else {
          confirmed = (await this.intake.receive(decodeMessage(message)))?.ok === true;
        }
      } catch { /* Retry; the original queue item and local evidence remain intact. */ }
      // Failed/lost ACK is deliberately propagated: cloud redelivery re-enters
      // the existing intake's durable idempotency and admission reconciliation.
      await this.api(queue, 'ack', {acks: confirmed ? [{lease_id: message.lease_id}] : [], retries: confirmed ? [] : [{lease_id: message.lease_id, delay_seconds: 60}]});
    }
  }
  async tick() {
    // Probe both independently; an ingress error cannot starve DLQ retention.
    const results = await Promise.allSettled([this.poll(this.config.ingressId), this.poll(this.config.deadLetterId, true)]);
    if (results.some(r => r.status === 'rejected')) throw new Error('queue_transport_unavailable');
    this.lastSuccess = this.now();
  }
  healthy() { return this.lastSuccess > 0 && this.now() - this.lastSuccess < 120000; }
}
