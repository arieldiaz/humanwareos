// One transport contract. JSON is decoded as a whole document, never extracted
// from prose or Markdown. Both harnesses use this same validator.
export const FINAL_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'message', 'status'],
  properties: {
    schemaVersion: {type: 'integer', const: 1},
    message: {type: 'string', minLength: 1},
    status: {type: 'string', enum: ['act', 'scheduled']},
  },
});
export const FINAL_INSTRUCTION = 'Return your entire final response as one JSON object, without Markdown fences or surrounding prose: {"schemaVersion":1,"message":"your natural-language reply","status":"act|scheduled"}. The status is your explicit decision: act returns the turn to the human (including an ordinary answer); scheduled requires a verified durable wake in this conversation. Headings and reactions have no protocol meaning. Closure is host-owned and never a model status.';

export function decodeFinal(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Final must be one complete JSON object'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'message,schemaVersion,status' ||
      value.schemaVersion !== 1 || typeof value.message !== 'string' || !value.message.trim() ||
      !FINAL_SCHEMA.properties.status.enum.includes(value.status)) throw new Error('Invalid final envelope schema');
  return Object.freeze(value);
}

export function validateEvidence(final, {wakes = []} = {}) {
  if (!FINAL_SCHEMA.properties.status.enum.includes(final.status)) throw new Error('Invalid model terminal status');
  if (final.status === 'scheduled' && !wakes.some(wake => wake.enabled === true && Number.isFinite(wake.nextRunAtMs)))
    throw new Error('Scheduled requires a verified enabled wake in this conversation');
  return final;
}

export function sameConversationWake(job, sessionKey, now = Date.now()) {
  return Boolean(job?.id && job.enabled === true && job.sessionKey === sessionKey &&
    job.payload?.kind === 'agentTurn' && job.delivery?.mode !== 'none' &&
    Number.isFinite(job.state?.nextRunAtMs) && job.state.nextRunAtMs > now);
}

export function finalText(result, kind) {
  if (kind === 'cursor') return result.payloads?.filter(p => !p.isReasoning).map(p => p.text ?? '').join('\n\n') ?? '';
  return result.assistantTexts?.join('\n\n') ?? '';
}

// Attachments are host-produced delivery facts, not extra model schema fields.
export function finalMedia(result) {
  const sent = new Set(result.messagingToolSentMediaUrls ?? []);
  return [...new Set([
    ...(result.payloads ?? []).flatMap(p => [...(p.mediaUrls ?? []), ...(p.mediaUrl ? [p.mediaUrl] : [])]),
    ...(result.toolMediaUrls ?? []), ...(result.toolAutoDeliveryMediaUrls ?? []),
  ])].filter(url => typeof url === 'string' && !sent.has(url));
}
