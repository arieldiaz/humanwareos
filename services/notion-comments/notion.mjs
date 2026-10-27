import {createHmac, timingSafeEqual} from 'node:crypto';

// Notion signs every event body with the subscription's verification token.
export function validSignature(rawBody, header, token) {
  if (!token || typeof header !== 'string') return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', token).update(rawBody).digest('hex')}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const RETRYABLE = new Set([429, 529]);

export class NotionClient {
  constructor({token, version = '2026-03-11', fetch = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms))}) {
    Object.assign(this, {token, version, fetch, sleep});
  }

  async request(method, path, body) {
    // Only rate-limit and overload responses are retried; they are rejected
    // before processing, so retrying a comment creation cannot duplicate it.
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetch(`https://api.notion.com/v1/${path}`, {
        method,
        headers: {authorization: `Bearer ${this.token}`, 'notion-version': this.version, 'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.ok) return response.json();
      if (RETRYABLE.has(response.status) && attempt < 4) {
        await this.sleep(Math.min(60, Number(response.headers.get('retry-after')) || 2 ** attempt) * 1000);
        continue;
      }
      const error = new Error(`notion_${method.toLowerCase()}_${response.status}`);
      error.status = response.status;
      throw error;
    }
  }

  me() { return this.request('GET', 'users/me'); }
  comment(id) { return this.request('GET', `comments/${encodeURIComponent(id)}`); }
  page(id) { return this.request('GET', `pages/${encodeURIComponent(id)}`); }
  // Posted with the agent's own connection token, so the author is that agent's bot user.
  reply({discussionId, markdown}) { return this.request('POST', 'comments', {discussion_id: discussionId, markdown}); }
}

export function plainText(richText = []) {
  return richText.map(part => part.plain_text ?? part.text?.content ?? '').join('');
}

export function pageTitle(page) {
  const title = Object.values(page?.properties ?? {}).find(p => p?.type === 'title');
  return plainText(title?.title).replace(/\s+/g, ' ').trim().slice(0, 200);
}
