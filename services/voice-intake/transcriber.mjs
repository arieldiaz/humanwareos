import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);
export const WHISPER_CLI = '/opt/homebrew/bin/whisper-cli';
export const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// Reads whisper.cpp's JSON output: one text fragment per segment.
export function parseWhisperJson(text) {
  const segments = JSON.parse(text).transcription ?? [];
  return segments.map(segment => String(segment.text ?? '')).join(' ').replace(/\s+/g, ' ').trim();
}

// Local whisper.cpp CLI on Metal. The model file is mapped from disk on each
// call, which on Apple silicon costs well under a second, so no server process
// stays resident. whisper.cpp reads only wav, flac, mp3, and ogg, so the stored
// capture is first decoded by ffmpeg to 16 kHz mono PCM. Audio never leaves the host.
export function whisperCppTranscriber({bin = WHISPER_CLI, model, language = 'en', ffmpeg = FFMPEG, threads, timeoutMs = 5 * 60_000} = {}) {
  if (!model) throw new Error('transcriber config requires model: the path of a ggml model file');
  return async (path) => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-intake-transcribe-'));
    try {
      const wav = join(dir, 'clip.wav'), out = join(dir, 'clip');
      await exec(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], {timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024});
      await exec(bin, ['-m', model, '-l', language, ...(threads ? ['-t', String(threads)] : []), '-nt', '-np', '-oj', '-of', out, '-f', wav], {timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024});
      return parseWhisperJson(await readFile(`${out}.json`, 'utf8'));
    } finally { await rm(dir, {recursive: true, force: true}); }
  };
}
