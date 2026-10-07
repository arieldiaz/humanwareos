import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {dkimSign} from 'mailauth/lib/dkim/sign.js';
import {dkimVerify} from 'mailauth/lib/dkim/verify.js';
export const config = {ownerMailbox: 'owner@example.test', sessionRecipients: ['liv@bot.example.test', 'max@bot.example.test'], maxBytes: 65536};
export const now = new Date('2026-09-24T12:00:00Z');
const keys = generateKeyPairSync('rsa', {modulusLength: 2048});
export const publicKey = keys.publicKey.export({type: 'spki', format: 'der'}).toString('base64');
const privateKey = keys.privateKey.export({type: 'pkcs8', format: 'pem'});
const fields = 'from:to:cc:subject:date:message-id:mime-version:content-type:references:in-reply-to:auto-submitted:precedence';
export const verify = raw => dkimVerify(raw, {resolver: async (name, type) => {
  assert.equal(type, 'TXT'); assert.equal(name, 'fixture._domainkey.example.test'); return [[`v=DKIM1; k=rsa; p=${publicKey}`]];
}, curTime: now});
export async function signedMail({recipient = 'max@bot.example.test', sender = 'owner@example.test', body = 'Investigate only; do not implement.', headers = '', signingDomain = 'example.test', headerList = fields, limit, id = 'signed@example.test', contentType = 'text/plain; charset=utf-8'} = {}) {
  const raw = `From: ${sender}\r\nTo: ${recipient}\r\nSubject: owner task\r\nDate: ${now.toUTCString()}\r\nMessage-ID: <${id}>\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n${headers}\r\n${body}\r\n`;
  const {signatures, errors} = await dkimSign(raw, {signTime: now, headerList, signatureData: [{signingDomain, selector: 'fixture', privateKey, ...(limit === undefined ? {} : {maxBodyLength: limit})}]});
  assert.equal(errors.length, 0);
  return signatures + raw;
}
