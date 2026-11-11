// Agent CLI for outbound mail. Credentials arrive only through the environment
// (EMAIL_SENDING_TOKEN, <OWNER>_SLACK_BOT_TOKEN); output is one JSON line.
//   send.mjs draft --to ADDR [--to ADDR] [--cc ADDR] [--from ADDR] [--subject TEXT] --text-file PATH|- [--thread CHANNEL:TS] [--reply]
//   send.mjs send --id DRAFT_ID
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {Store} from './store.mjs';
import {Outbound, cloudflareSender} from './outbound.mjs';
import {isMainModule, locations, slackTokens} from './server.mjs';

export async function run(argv, {env = process.env, makeSender = cloudflareSender} = {}) {
  const [command, ...rest] = argv;
  const {values} = parseArgs({args: rest, strict: true, options: {
    to: {type: 'string', multiple: true}, cc: {type: 'string', multiple: true}, from: {type: 'string'}, subject: {type: 'string'},
    'text-file': {type: 'string'}, thread: {type: 'string'}, reply: {type: 'boolean'}, id: {type: 'string'}}});
  const paths = locations(env);
  const config = JSON.parse(readFileSync(paths.config));
  const store = new Store(join(paths.state, 'intake.sqlite3'), {tablePrefix: config.tablePrefix});
  try {
    const outbound = new Outbound({store, config, tokens: slackTokens(config, env),
      send: (body) => makeSender({accountId: config.queue?.accountId, token: env.EMAIL_SENDING_TOKEN})(body)});
    if (command === 'draft') {
      const file = values['text-file'] ?? '';
      const text = file ? readFileSync(file === '-' ? 0 : file, 'utf8') : '';
      return await outbound.draft({to: values.to, cc: values.cc, from: values.from, subject: values.subject, text, thread: values.thread, reply: values.reply});
    }
    if (command === 'send') return await outbound.send(values.id);
    throw new Error('usage');
  } finally { store.close(); }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.umask(0o077);
  try { console.log(JSON.stringify(await run(process.argv.slice(2)))); }
  catch (error) { console.log(JSON.stringify({error: String(error.message).slice(0, 80)})); process.exitCode = 1; }
}
