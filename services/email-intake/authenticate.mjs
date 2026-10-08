import PostalMime from 'postal-mime';
import {dkimVerify} from 'mailauth/lib/dkim/verify.js';
import {createHash} from 'node:crypto';

// The local trusted ingress verifies the original bytes against DNS DKIM keys.
// Cloudflare Authentication-Results, visible From and JSON authority claims are
// deliberately irrelevant. Exact domain alignment (stricter than relaxed DMARC),
// full-body coverage and signed author/routing headers are mandatory.
export async function authenticateMail(event, config, {verify = dkimVerify, now = Date.now()} = {}) {
  if (!event.rawBase64) return {event, authentication: null, attachments: []};
  if (typeof event.rawBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.rawBase64)) throw new Error('invalid_mime');
  const raw = Buffer.from(event.rawBase64, 'base64');
  if (raw.length > config.maxBytes || raw.toString('base64') !== event.rawBase64) throw new Error('invalid_mime');
  const parsed = await PostalMime.parse(raw);
  const headers = parsed.headers;
  const get = key => headers.filter(h => h.key === key);
  const header = key => get(key)[0]?.value ?? '';
  const ids = value => String(value).match(/<[^<>\s]+>/g) ?? [];
  const sender = parsed.from?.address?.toLowerCase();
  const normalized = {...event, sender: sender || event.sender || event.envelopeFrom, sizeBytes: raw.length, rawSize: raw.length,
    subject: parsed.subject ?? '', messageId: parsed.messageId ?? '', inReplyTo: ids(header('in-reply-to')).at(-1) ?? null,
    references: ids(header('references')).slice(-100), autoSubmitted: header('auto-submitted'), precedence: header('precedence'),
    textBody: String(parsed.text ?? ''), htmlOnly: !parsed.text && Boolean(parsed.html)};
  const attachments = (parsed.attachments ?? []).map((a, i) => ({index: i, name: String(a.filename ?? 'attachment').slice(0, 180), mimeType: a.mimeType, content: Buffer.from(a.content).toString('base64')}));
  const calendar = attachments.find(a => a.mimeType === 'text/calendar' || a.name.toLowerCase().endsWith('.ics'));
  normalized.calendarPayload = calendar ? Buffer.from(calendar.content, 'base64').toString('utf8') : normalized.textBody.includes('BEGIN:VCALENDAR') ? normalized.textBody : null;
  const denied = {event: normalized, authentication: null, attachments};
  if (sender !== config.ownerMailbox || !config.sessionRecipients.includes(event.recipient)) return denied;
  const singleton = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'content-type', 'mime-version', 'references', 'in-reply-to', 'auto-submitted', 'precedence'];
  if (singleton.some(key => get(key).length > 1) || !['from', 'to', 'subject', 'date', 'message-id'].every(key => get(key).length === 1)) return denied;
  const destinations = [...(parsed.to ?? []), ...(parsed.cc ?? [])].map(a => a.address?.toLowerCase());
  if (!destinations.includes(event.recipient)) return denied;
  const date = Date.parse(header('date'));
  if (!Number.isFinite(date) || date > now + 300000 || now - date > 7 * 86400000) return denied;
  let verified;
  try { verified = await verify(raw); } catch { throw new Error('sender_verification_unavailable'); }
  // DNS outages are retryable, not a permanent unauthenticated classification.
  if (verified.results?.some(r => r.status?.result === 'temperror')) throw new Error('sender_verification_unavailable');
  if (verified.headerFrom?.length !== 1 || verified.headerFrom[0].toLowerCase() !== config.ownerMailbox) return denied;
  const domain = config.ownerMailbox.split('@')[1];
  const required = singleton.filter(key => get(key).length);
  const signature = verified.results?.find(r => {
    const signed = (r.signingHeaders?.keys ?? '').toLowerCase().split(':').map(s => s.trim());
    return r.status?.result === 'pass' && r.signingDomain?.toLowerCase() === domain && ['rsa-sha256', 'ed25519-sha256'].includes(r.algo)
      && r.canonBodyLengthLimit === undefined && r.signatureTimeValid !== false && required.every(key => signed.includes(key));
  });
  if (!signature) return denied;
  return {...denied, authentication: {verified: true, principal: sender, method: 'aligned-dkim-full-body',
    evidenceRef: `sha256:${createHash('sha256').update(raw).digest('hex')}`}};
}
