import {framework, digest} from './framework.mjs';
const {slackApi} = await framework('ops/openclaw/plugins/run-signature/index.js');

async function boundedCall(method, token, args) {
  let timer;
  try {
    return await Promise.race([slackApi(method, token, args), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('slack_timeout')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

// Use the existing adapter transport and canonical planner. No gateway agent run,
// send-session creation, signature, model, command parser, or destination inference.
export class SlackAdapter {
  constructor({channel, tokens, call = boundedCall, eventType = 'email_intake'}) { Object.assign(this, {channel, tokens, call, eventType: eventType ?? 'email_intake'}); this.bots = {}; }
  async verify() {
    for (const owner of Object.keys(this.tokens)) {
      const token = this.tokens[owner];
      if (!token) throw new Error('slack_credentials_missing');
      const auth = await this.call('auth.test', token, {});
      const {channel} = await this.call('conversations.info', token, {channel: this.channel.channelId});
      if (!auth.user_id || channel?.name !== this.channel.name || channel.is_archived || !channel.is_member) throw new Error('inbox_unavailable');
      this.bots[owner] = auth.user_id;
    }
  }
  async find(effect, conversation, startedAt) {
    const method = effect.kind === 'intake_root' ? 'conversations.history' : 'conversations.replies';
    let cursor;
    do {
      const page = await this.call(method, this.tokens[conversation.owner], {channel: this.channel.channelId,
        ts: conversation.intakeThread?.threadTs, oldest: String(Date.parse(startedAt) / 1000 - 60),
        limit: 200, include_all_metadata: true, cursor});
      const message = page.messages?.find((m) => m.user === this.bots[conversation.owner] && m.metadata?.event_type === this.eventType && m.metadata.event_payload?.effect === digest(effect.key));
      if (message) return {channelId: this.channel.channelId, threadTs: message.ts};
      cursor = page.response_metadata?.next_cursor;
      if (page.has_more && !cursor) throw new Error('slack_reconciliation_incomplete');
    } while (cursor);
    return null;
  }
  async send(effect, conversation, text) {
    const key = digest(effect.key);
    const result = await this.call('chat.postMessage', this.tokens[conversation.owner], {
      channel: this.channel.channelId, text, thread_ts: effect.kind === 'intake_root' ? undefined : conversation.intakeThread?.threadTs,
      client_msg_id: `${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20,32)}`,
      metadata: JSON.stringify({event_type: this.eventType, event_payload: {effect: key}}),
      mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
    });
    if (!result.ts || result.channel !== this.channel.channelId) throw new Error('slack_confirmation_missing');
    return {channelId: result.channel, threadTs: result.ts};
  }
}
