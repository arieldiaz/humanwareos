import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collapseTrailingLoop, collapseTrailingLoops, parseWhisperJson, parseWhisperSegments, silenceTrimFilter, whisperCppTranscriber} from './transcriber.mjs';

// Stand-ins for ffmpeg and whisper-cli that record their argv and write what the
// adapter reads, so the test proves the contract without a model or a GPU. The
// fake ffmpeg writes `wavBytes` of output: a trimmed clip of real length by
// default, or the header-only file ffmpeg leaves when the whole clip was silent.
function fakeBinaries(dir, {transcription = [{text: ' Testing. One, two, three.'}, {text: ' Acknowledge this.'}], exit = 0, wavBytes = 32_000} = {}) {
  const script = (name, body) => { const path = join(dir, name); writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/${name}.argv"\n${body}\n`); chmodSync(path, 0o700); return path; };
  const ffmpeg = script('ffmpeg', `for last; do :; done; head -c ${wavBytes} /dev/zero > "$last"`);
  const whisper = script('whisper-cli', `out=""; while [ $# -gt 0 ]; do [ "$1" = -of ] && out="$2"; shift; done\nprintf '%s' '${JSON.stringify({transcription})}' > "$out.json"\nexit ${exit}`);
  const argv = (name) => readFileSync(join(dir, `${name}.argv`), 'utf8').trim().split('\n');
  return {ffmpeg, whisper, argv};
}

test('whisper.cpp JSON segments join into one normalized transcript', () => {
  assert.equal(parseWhisperJson(JSON.stringify({transcription: [{text: ' Testing. One, two, three.'}, {text: ' Acknowledge this.  '}]})), 'Testing. One, two, three. Acknowledge this.');
  assert.deepEqual(parseWhisperSegments(JSON.stringify({transcription: [{text: ' a  b '}, {text: '   '}, {text: 'c'}]})), ['a b', 'c']);
  assert.equal(parseWhisperJson('{}'), '');
});

test('the silence trim keeps 300 ms of quiet on both ends at -45 dB', () => {
  assert.equal(silenceTrimFilter(), 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.3,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.3,areverse');
  assert.match(silenceTrimFilter({threshold: '-40dB', padding: 0.5}), /^silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0\.5,areverse,/);
});

test('a phrase looping more than four times at the tail collapses to its first occurrence', () => {
  const loop = ' and shake it'.repeat(9);
  assert.deepEqual(collapseTrailingLoop(`I get a big bulk.${loop}.`), {text: 'I get a big bulk. and shake it.', repeats: 9, phrase: 'and shake it'});
  // Case and punctuation do not break the match; the longest covering phrase wins.
  assert.deepEqual(collapseTrailingLoop('Go. Thank you, thank you. Thank you, thank you. Thank you, thank you. Thank you, thank you. Thank you, thank you.'), {text: 'Go. Thank you, thank you.', repeats: 5, phrase: 'thank you thank you'});
  assert.equal(collapseTrailingLoop('Go thank you thank you thank you thank you thank you thank you').text, 'Go thank you thank you thank you thank you thank you thank you', 'two-word phrases are below the 3-word floor');
  // Exactly four repeats is legitimate emphasis.
  const four = `Ready?${' let it go'.repeat(4)}`;
  assert.deepEqual(collapseTrailingLoop(four), {text: four, repeats: 0, phrase: null});
  // Repetition inside the body is never touched.
  const body = `${' and shake it'.repeat(9).trim()}. Then it settles and we are done here today.`;
  assert.equal(collapseTrailingLoop(body).text, body);
  assert.equal(collapseTrailingLoop('').text, '');
});

test('trailing looped segments collapse from the end and stop at the first clean one', () => {
  // The real capture of 2026-11-08: the body is kept whole, each hallucinated
  // trailing segment keeps one occurrence, and the count covers both.
  const segments = ['a cost comparison table if I get a big bulk.', `And${' shake it and'.repeat(8)} shake it.`, `And then${' shake it and'.repeat(7)} shake it.`];
  assert.deepEqual(collapseTrailingLoops(segments), {text: 'a cost comparison table if I get a big bulk. And shake it. And then shake it and shake it.', repeats: 14, phrase: 'and shake it'});
  const clean = ['one two three', 'four five six'];
  assert.deepEqual(collapseTrailingLoops(clean), {text: 'one two three four five six', repeats: 0, phrase: null});
  // A loop in an earlier segment behind a clean final segment is body, not tail.
  assert.equal(collapseTrailingLoops([segments[1], 'And that is the whole plan.']).text, `${segments[1]} And that is the whole plan.`);
});

test('the whisper.cpp adapter trims silence, decodes to 16 kHz mono, runs the CLI without text context, and cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-intake-transcriber-'));
  try {
    const {ffmpeg, whisper, argv} = fakeBinaries(dir);
    const clip = join(dir, 'capture.m4a');
    writeFileSync(clip, 'audio');
    const events = [];
    const transcribe = whisperCppTranscriber({bin: whisper, ffmpeg, model: '/models/ggml-large-v3-turbo.bin', threads: 8, log: (entry) => events.push(entry)});
    assert.equal(await transcribe(clip), 'Testing. One, two, three. Acknowledge this.');
    assert.deepEqual(events, [], 'a clean transcript logs nothing');
    const decode = argv('ffmpeg');
    assert.equal(decode[decode.indexOf('-i') + 1], clip);
    assert.equal(decode[decode.indexOf('-af') + 1], silenceTrimFilter());
    assert.deepEqual(decode.slice(decode.indexOf('-ar'), decode.indexOf('-ar') + 4), ['-ar', '16000', '-ac', '1']);
    assert.match(decode.at(-1), /voice-intake-transcribe-.*\/clip\.wav$/);
    const run = argv('whisper-cli');
    assert.equal(run[run.indexOf('-m') + 1], '/models/ggml-large-v3-turbo.bin');
    assert.equal(run[run.indexOf('-l') + 1], 'en');
    assert.equal(run[run.indexOf('-t') + 1], '8');
    assert.equal(run[run.indexOf('-mc') + 1], '0', 'no text context carries between windows');
    assert.equal(run[run.indexOf('-f') + 1], decode.at(-1), 'the CLI reads the decoded wav');
    for (const flag of ['-nt', '-np', '-oj']) assert.ok(run.includes(flag), flag);
    const scratch = run[run.indexOf('-of') + 1].replace(/\/clip$/, '');
    assert.throws(() => readFileSync(join(scratch, 'clip.json')), 'scratch files are removed');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a looping tail is collapsed and logged; a clip that trims to silence is an empty transcript without a CLI run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-intake-transcriber-'));
  try {
    const transcription = [{text: ' Testing from the iPad.'}, {text: ` And${' shake it and'.repeat(16)} shake it.`}];
    const {ffmpeg, whisper} = fakeBinaries(dir, {transcription});
    const clip = join(dir, 'capture.m4a');
    writeFileSync(clip, 'audio');
    const events = [];
    const transcribe = whisperCppTranscriber({bin: whisper, ffmpeg, model: '/models/x.bin', log: (entry) => events.push(entry)});
    assert.equal(await transcribe(clip), 'Testing from the iPad. And shake it.');
    assert.equal(events.length, 1);
    assert.deepEqual({...events[0], at: undefined}, {at: undefined, event: 'transcript_loop_trimmed', clip: 'capture.m4a', repeats: 16, phrase: 'and shake it'});
    assert.match(events[0].at, /^\d{4}-\d{2}-\d{2}T/);

    mkdirSync(join(dir, 'silent'));
    const silent = fakeBinaries(join(dir, 'silent'), {wavBytes: 78});
    assert.equal(await whisperCppTranscriber({bin: silent.whisper, ffmpeg: silent.ffmpeg, model: '/models/x.bin'})(clip), '');
    assert.throws(() => silent.argv('whisper-cli'), 'whisper-cli never ran on a header-only wav');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a failing CLI or a missing model surfaces as an error the pipeline retries', async () => {
  assert.throws(() => whisperCppTranscriber({}), /requires model/);
  const dir = mkdtempSync(join(tmpdir(), 'voice-intake-transcriber-'));
  try {
    const {ffmpeg, whisper} = fakeBinaries(dir, {exit: 3});
    const clip = join(dir, 'capture.m4a');
    writeFileSync(clip, 'audio');
    await assert.rejects(whisperCppTranscriber({bin: whisper, ffmpeg, model: '/models/x.bin'})(clip), /Command failed/);
    await assert.rejects(whisperCppTranscriber({bin: join(dir, 'missing'), ffmpeg, model: '/models/x.bin'})(clip), {code: 'ENOENT'});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
