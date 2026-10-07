// No body excerpts, MIME, evidence IDs, links, or executable Slack markup.
export function safeText(value, limit = 160) {
  return String(value ?? '').replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/(?:bearer\s+\S+|(?:token|password|secret|api[_ -]?key)\s*[:=]\s*\S+|\b(?:xox[baprs]-|sk-)[\w-]+)/gi, '[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, '[redacted]').replace(/[<>@&*`_~\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function render(message, evidence, label, receipt) {
  const result = evidence.domain;
  const outcome = evidence.value.authentication ? 'Authenticated owner request; continuing in this Slack thread.' : receipt ? `Calendar ${receipt.outcome}; verified stored.` : result?.status === 'rejected' ? 'Invitation rejected; review required in Slack.' : message.automatic !== 'none' ? 'Recorded without an automatic reply.' : 'Awaiting review in Slack; promotion required for work.';
  const calendar = receipt && result?.display;
  return `${receipt ? 'Calendar' : 'Email'} · ${label}\nFrom: ${safeText(message.sender)}\nSubject: ${safeText(message.subject) || '(no subject)'}\nSummary: ${calendar ? `${safeText(calendar.title)} · ${safeText(calendar.when)}. ` : ''}${outcome}\nReceived: ${message.receivedAt}`;
}
