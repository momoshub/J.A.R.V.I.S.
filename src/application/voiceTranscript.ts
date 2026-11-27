/**
 * Turns the audio clips on a message into text for its turn.
 *
 * A failure never loses the clip: it becomes a note in the text, so the turn
 * still starts and says the audio could not be heard.
 */
import { audioClipsOf, withTranscripts, type AudioClip, type RawAudioFile, type Transcript } from "../domain/voiceMessage.ts";

/** Fetches and transcribes one clip; throws or resolves a failed transcript when it cannot. */
export type Transcriber = (clip: AudioClip) => Promise<Transcript>;

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

/** The text for a turn: `typed` plus a transcript block per clip. No clips: `typed` unchanged. */
export const textWithVoice = async (
  typed: string,
  files: readonly RawAudioFile[] | undefined,
  transcribe: Transcriber | undefined,
  log: (line: string) => void = () => {},
): Promise<string> => {
  const clips = audioClipsOf(files);
  if (clips.length === 0) return typed;
  // One after another: each run is a large model on the host, several at once would starve it.
  const results: { name: string; transcript: Transcript }[] = [];
  for (const clip of clips) {
    if (!transcribe) {
      results.push({ name: clip.name, transcript: { ok: false, reason: "transcription is not set up" } });
      continue;
    }
    try {
      results.push({ name: clip.name, transcript: await transcribe(clip) });
    } catch (e) {
      log(`voice transcription failed for "${clip.name}": ${describe(e)}`);
      results.push({ name: clip.name, transcript: { ok: false, reason: describe(e) } });
    }
  }
  return withTranscripts(typed, results);
};
