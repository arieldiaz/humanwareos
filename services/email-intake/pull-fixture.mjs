import {QueueConsumer, RawObjects} from './queue.mjs';
// Exercise the real outbound consumer and Cloudflare's base64 wire format.
export async function deliverQueued(intake, directory, event) {
  let ack = 0, retry = 0;
  const config = {accountId: 'a'.repeat(32), ingressId: 'b'.repeat(32), deadLetterId: 'c'.repeat(32)};
  const consumer = new QueueConsumer({config, token: 'fixture', intake, directory, fetcher: async (url, options) => {
    if (url.endsWith('/pull')) return Response.json({success: true, result: {messages: [{id: event.eventId, lease_id: 'fixture', metadata: {'CF-Content-Type': 'json'}, body: Buffer.from(JSON.stringify(event)).toString('base64')}]}});
    const body = JSON.parse(options.body); ack += body.acks.length; retry += body.retries.length;
    return Response.json({success: true, result: {}});
  }});
  await consumer.poll(config.ingressId);
  return {ack, retry};
}
// One in-memory bucket: the Worker's R2 binding writes; the intake's real REST client reads and deletes.
export function memoryBucket() {
  const stored = new Map(), prefix = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/r2/buckets/agent-email-raw/objects/`;
  const objects = new RawObjects({accountId: 'a'.repeat(32), bucket: 'agent-email-raw', token: 'fixture', fetcher: async (url, {method, headers}) => {
    if (!url.startsWith(prefix) || headers.authorization !== 'Bearer fixture') return new Response(null, {status: 403});
    const key = url.slice(prefix.length);
    if (method === 'DELETE') { stored.delete(key); return Response.json({success: true}); }
    return stored.has(key) ? new Response(stored.get(key)) : new Response(null, {status: 404});
  }});
  return {stored, objects, binding: {put: async (key, value) => { stored.set(key, Buffer.from(value)); }}};
}
