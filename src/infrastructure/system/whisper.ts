/**
 * Local speech-to-text for voice messages: ffmpeg converts the clip to 16 kHz
 * mono wav, whisper.cpp's `whisper-cli` transcribes it with the language
 * auto-detected. Nothing leaves the machine.
 *
 * Every failure (binary or model missing, download refused, timeout, empty
 * result) comes back as a failed `Transcript` with a short reason, so the turn
 * can say the audio could not be heard instead of dropping it.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSlackFileUrl } from "../../domain/slackProxy.ts";
import type { AudioClip, Transcript } from "../../domain/voiceMessage.ts";

export type WhisperConfig = {
  /** Path of the whisper.cpp CLI. */
  readonly whisperBin: string;
  /** Path of the ggml model file. */
  readonly modelPath: string;
  /** Path of ffmpeg. */
  readonly ffmpegBin: string;
  /** Wall-clock limit for each of the two steps. */
  readonly timeoutMs: number;
  readonly botToken: string;
};

/** Biggest clip fetched; a voice message is a few hundred KB. */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

type Run = (cmd: readonly string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

const run: Run = async (cmd, timeoutMs) => {
  const proc = Bun.spawn({ cmd: [...cmd], stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
};

/** whisper-cli prints `[00:00:00.000 --> 00:00:02.000]  words` per segment with timestamps; this keeps the words. */
export const cleanTranscript = (raw: string): string =>
  raw
    .split("\n")
    .map((l) => l.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, "").trim())
    .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|SILENCE)\]$/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** Fetches a Slack private file with the bot token; the token only goes to a Slack file host, redirects included. */
export const fetchSlackAudio = async (url: string, token: string, doFetch: typeof fetch = fetch, timeoutMs = 60_000): Promise<Uint8Array> => {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSlackFileUrl(target)) throw new Error("not a Slack file url");
    const res = await doFetch(target, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new Error("redirect without a location");
      target = new URL(next, target).toString();
      continue;
    }
    if (!res.ok) throw new Error(`download failed (http ${res.status})`);
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) throw new Error("file is too large");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_AUDIO_BYTES) throw new Error("file is too large");
    if (bytes.length === 0) throw new Error("empty download");
    return bytes;
  }
  throw new Error("too many redirects");
};

export const createWhisperTranscriber = (
  cfg: WhisperConfig,
  deps: { run?: Run; fetchAudio?: (url: string) => Promise<Uint8Array>; exists?: (p: string) => boolean } = {},
): ((clip: AudioClip) => Promise<Transcript>) => {
  const exec = deps.run ?? run;
  const exists = deps.exists ?? existsSync;
  const fetchAudio = deps.fetchAudio ?? ((url: string) => fetchSlackAudio(url, cfg.botToken));
  return async (clip) => {
    if (!exists(cfg.whisperBin)) return { ok: false, reason: "the speech-to-text binary is not installed" };
    if (!exists(cfg.modelPath)) return { ok: false, reason: "the speech-to-text model is not installed" };
    if (!exists(cfg.ffmpegBin)) return { ok: false, reason: "ffmpeg is not installed" };
    if (!clip.url) return { ok: false, reason: "the clip has no download url" };
    if (clip.size !== undefined && clip.size > MAX_AUDIO_BYTES) return { ok: false, reason: "file is too large" };
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "voice-"));
      const input = join(dir, "in");
      const wav = join(dir, "clip.wav");
      await writeFile(input, await fetchAudio(clip.url));
      const conv = await exec([cfg.ffmpegBin, "-nostdin", "-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], cfg.timeoutMs);
      if (conv.code !== 0) return { ok: false, reason: conv.code === 137 || conv.code === 143 ? "transcription timed out" : "the audio could not be converted" };
      // `-l auto` detects the language (Vietnamese and English alike); `-nt` drops timestamps.
      const out = await exec([cfg.whisperBin, "-m", cfg.modelPath, "-f", wav, "-l", "auto", "-nt"], cfg.timeoutMs);
      if (out.code !== 0) return { ok: false, reason: out.code === 137 || out.code === 143 ? "transcription timed out" : "transcription failed" };
      const text = cleanTranscript(out.stdout);
      return text ? { ok: true, text } : { ok: false, reason: "no speech was found" };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message.slice(0, 120) : "transcription failed" };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
};
