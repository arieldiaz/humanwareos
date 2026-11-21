import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);
export const WHISPER_CLI = '/opt/homebrew/bin/whisper-cli';
export const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// Leading and trailing quiet is cut before transcription, keeping `padding`
// seconds on each side. -45 dB sits between the silence guard's -50 dB floor and
// the quietest speech in the real captures; measured on them, the words are
// unchanged and only punctuation moves.
export function silenceTrimFilter({threshold = '-45dB', padding = 0.3} = {}) {
  const trim = `silenceremove=start_periods=1:start_threshold=${threshold}:start_silence=${padding}`;
  return `${trim},areverse,${trim},areverse`;
}

// Reads whisper.cpp's JSON output: one text fragment per segment.
export function parseWhisperSegments(text) {
  return (JSON.parse(text).transcription ?? []).map(segment => String(segment.text ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function parseWhisperJson(text) {
  return parseWhisperSegments(text).join(' ');
}

const wordKey = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// Whisper's decoder can lock onto its own last phrase and emit it until the
// window ends, e.g. "and shake it" seventeen times. A phrase of 3–6 words that
// repeats more than `maxRepeats` times back to back at the end of a segment is
// cut after its first occurrence. Only the tail is examined, so legitimate
// repetition inside the body is kept.
export function collapseTrailingLoop(text, {maxRepeats = 4, minWords = 3, maxWords = 6} = {}) {
  const words = text.split(/\s+/).filter(Boolean), keys = words.map(wordKey);
  let best = null;
  for (let n = minWords; n <= maxWords; n++) {
    let repeats = 1;
    while ((repeats + 1) * n <= keys.length && keys.slice(-n).every((key, i) => key === keys[keys.length - (repeats + 1) * n + i])) repeats++;
    if (repeats > maxRepeats && (!best || repeats * n > best.repeats * best.n)) best = {n, repeats};
  }
  if (!best) return {text, repeats: 0, phrase: null};
  const kept = words.slice(0, words.length - best.n * (best.repeats - 1));
  const punctuation = words.at(-1).match(/[.!?,;:]+$/)?.[0] ?? '';
  if (punctuation && !/[.!?,;:]$/.test(kept.at(-1))) kept[kept.length - 1] += punctuation;
  return {text: kept.join(' '), repeats: best.repeats, phrase: words.slice(-best.n).map(wordKey).join(' ')};
}

// Segments are whisper's own decode units, so a loop lives inside one. Trailing
// segments are collapsed from the end until a segment without a loop is found.
export function collapseTrailingLoops(segments, options) {
  const out = [...segments];
  let repeats = 0, phrase = null;
  for (let i = out.length - 1; i >= 0; i--) {
    const result = collapseTrailingLoop(out[i], options);
    if (!result.repeats) break;
    out[i] = result.text;
    repeats += result.repeats - 1;
    phrase ??= result.phrase;
  }
  return {text: out.join(' '), repeats, phrase};
}

// Local whisper.cpp CLI on Metal. The model file is mapped from disk on each
// call, which on Apple silicon costs well under a second, so no server process
// stays resident. whisper.cpp reads only wav, flac, mp3, and ogg, so the stored
// capture is first decoded by ffmpeg to 16 kHz mono PCM with its quiet ends
// trimmed. Audio never leaves the host. `-mc 0` stops the decoder from
// conditioning on its previous text, which is what let a phrase repeat across a
// whole window on a real capture; measured on the real clips, every other
// transcript is unchanged. A capture that trims to nothing is silence and
// returns an empty transcript, which the pipeline holds as `empty_transcript`.
export function whisperCppTranscriber({bin = WHISPER_CLI, model, language = 'en', ffmpeg = FFMPEG, threads, timeoutMs = 5 * 60_000, log = (entry) => console.error(JSON.stringify(entry))} = {}) {
  if (!model) throw new Error('transcriber config requires model: the path of a ggml model file');
  const minWavBytes = 44 + 16000 * 2 * 0.1;
  return async (path) => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-intake-transcribe-'));
    try {
      const wav = join(dir, 'clip.wav'), out = join(dir, 'clip');
      await exec(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-af', silenceTrimFilter(), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], {timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024});
      if ((await stat(wav)).size < minWavBytes) return '';
      await exec(bin, ['-m', model, '-l', language, ...(threads ? ['-t', String(threads)] : []), '-mc', '0', '-nt', '-np', '-oj', '-of', out, '-f', wav], {timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024});
      const {text, repeats, phrase} = collapseTrailingLoops(parseWhisperSegments(await readFile(`${out}.json`, 'utf8')));
      if (repeats) log({at: new Date().toISOString(), event: 'transcript_loop_trimmed', clip: basename(path), repeats, phrase});
      return text;
    } finally { await rm(dir, {recursive: true, force: true}); }
  };
}
