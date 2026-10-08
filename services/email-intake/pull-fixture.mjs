import {QueueConsumer} from './queue.mjs';
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
