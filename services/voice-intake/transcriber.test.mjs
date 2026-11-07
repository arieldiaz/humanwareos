import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseWhisperJson, whisperCppTranscriber} from './transcriber.mjs';

// Stand-ins for ffmpeg and whisper-cli that record their argv and write what the
// adapter reads, so the test proves the contract without a model or a GPU.
function fakeBinaries(dir, {transcription = [{text: ' Testing. One, two, three.'}, {text: ' Acknowledge this.'}], exit = 0} = {}) {
  const script = (name, body) => { const path = join(dir, name); writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/${name}.argv"\n${body}\n`); chmodSync(path, 0o700); return path; };
  const ffmpeg = script('ffmpeg', 'for last; do :; done; cp "$1" "$last" 2>/dev/null || : > "$last"');
  const whisper = script('whisper-cli', `out=""; while [ $# -gt 0 ]; do [ "$1" = -of ] && out="$2"; shift; done\nprintf '%s' '${JSON.stringify({transcription})}' > "$out.json"\nexit ${exit}`);
  const argv = (name) => readFileSync(join(dir, `${name}.argv`), 'utf8').trim().split('\n');
  return {ffmpeg, whisper, argv};
}

test('whisper.cpp JSON segments join into one normalized transcript', () => {
  assert.equal(parseWhisperJson(JSON.stringify({transcription: [{text: ' Testing. One, two, three.'}, {text: ' Acknowledge this.  '}]})), 'Testing. One, two, three. Acknowledge this.');
  assert.equal(parseWhisperJson('{}'), '');
});

test('the whisper.cpp adapter decodes to 16 kHz mono first, points the CLI at the configured model, and cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-intake-transcriber-'));
  try {
    const {ffmpeg, whisper, argv} = fakeBinaries(dir);
    const clip = join(dir, 'capture.m4a');
    writeFileSync(clip, 'audio');
    const transcribe = whisperCppTranscriber({bin: whisper, ffmpeg, model: '/models/ggml-large-v3-turbo.bin', threads: 8});
    assert.equal(await transcribe(clip), 'Testing. One, two, three. Acknowledge this.');
    const decode = argv('ffmpeg');
    assert.equal(decode[decode.indexOf('-i') + 1], clip);
    assert.deepEqual(decode.slice(decode.indexOf('-ar'), decode.indexOf('-ar') + 4), ['-ar', '16000', '-ac', '1']);
    assert.match(decode.at(-1), /voice-intake-transcribe-.*\/clip\.wav$/);
    const run = argv('whisper-cli');
    assert.equal(run[run.indexOf('-m') + 1], '/models/ggml-large-v3-turbo.bin');
    assert.equal(run[run.indexOf('-l') + 1], 'en');
    assert.equal(run[run.indexOf('-t') + 1], '8');
    assert.equal(run[run.indexOf('-f') + 1], decode.at(-1), 'the CLI reads the decoded wav');
    for (const flag of ['-nt', '-np', '-oj']) assert.ok(run.includes(flag), flag);
    const scratch = run[run.indexOf('-of') + 1].replace(/\/clip$/, '');
    assert.throws(() => readFileSync(join(scratch, 'clip.json')), 'scratch files are removed');
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
