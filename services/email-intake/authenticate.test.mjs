import test from 'node:test';
import assert from 'node:assert/strict';
import {dkimVerify} from 'mailauth/lib/dkim/verify.js';
import {authenticateMail} from './authenticate.mjs';
import {config, now, verify, signedMail, publicKey} from './auth-fixture.mjs';
const event = raw => ({rawBase64: Buffer.from(raw).toString('base64'), recipient: 'max@bot.example.test', sender: 'forged@invalid.test', textBody: 'forged JSON task', authentication: {verified: true}});
const auth = raw => authenticateMail(event(raw), config, {verify, now: now.getTime()});
test('real crypto/DNS-key verification authenticates exact owner and reparses signed body', async () => {
  const raw = await signedMail(); const result = await auth(raw);
  assert.equal(result.authentication?.principal, config.ownerMailbox);
  assert.equal(result.event.sender, config.ownerMailbox); assert.match(result.event.textBody, /Investigate only/);
  assert.doesNotMatch(result.event.textBody, /forged JSON/);
});
test('spoofed From, forged authentication headers, missing and failed authentication do not authorize', async () => {
  const raw = await signedMail();
  for (const message of [raw.replace('Investigate only', 'Implement now'), raw.slice(raw.indexOf('From:')), `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.test; dmarc=pass\r\n${raw.slice(raw.indexOf('From:'))}`]) {
    assert.equal((await auth(message)).authentication, null);
  }
  assert.equal((await authenticateMail({sender: config.ownerMailbox, authentication: {verified: true}}, config)).authentication, null);
});
test('unrelated sender, duplicate From, partial body, unsigned routing and cross-recipient replay are rejected', async () => {
  const raw = await signedMail();
  for (const message of [await signedMail({sender: 'other@example.test'}), `From: owner@example.test\r\n${raw}`, await signedMail({limit: 5}), await signedMail({headerList: 'from:subject:date:message-id'}), await signedMail({recipient: 'liv@bot.example.test'})]) {
    assert.equal((await auth(message)).authentication, null);
  }
});
test('unaligned DKIM domain cannot confer owner authority', async () => {
  const raw = await signedMail({signingDomain: 'attacker.test'});
  const result = await authenticateMail(event(raw), config, {now: now.getTime(), verify: bytes => dkimVerify(bytes, {resolver: async () => [[`v=DKIM1; p=${publicKey}`]], curTime: now})});
  assert.equal(result.authentication, null);
});
test('DNS outage remains retryable and kids never creates owner authority', async () => {
  const raw = await signedMail();
  await assert.rejects(authenticateMail(event(raw), config, {now: now.getTime(), verify: async () => ({results: [{status: {result: 'temperror'}}]})}), /verification_unavailable/);
  const kids = {...event(raw), recipient: 'kids@bot.example.test'};
  assert.equal((await authenticateMail(kids, config, {verify, now: now.getTime()})).authentication, null);
});

test('MIME attachment bytes preserved; long authored body is never silently truncated', async () => {
  const longBody = 'Context '.repeat(5000) + '\nResearch only, do not implement.';
  const result = await auth(await signedMail({body: longBody}));
  assert.ok(result.authentication); assert.ok(result.event.textBody.endsWith('Research only, do not implement.\n'));
  const body = '--fixture\r\nContent-Type: text/plain\r\n\r\nFor context only.\r\n--fixture\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="../../evidence.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi1maXh0dXJl\r\n--fixture--';
  const attached = await auth(await signedMail({body, contentType: 'multipart/mixed; boundary="fixture"'}));
  assert.ok(attached.authentication); assert.equal(attached.attachments.length, 1);
  assert.equal(Buffer.from(attached.attachments[0].content, 'base64').toString(), '%PDF-fixture');
});
