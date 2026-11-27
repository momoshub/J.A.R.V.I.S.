/**
 * Voice messages: a Slack audio clip with no text.
 *
 * Such a message arrives as a `file_share` whose text is empty, so the empty
 * check dropped it and nobody heard the clip. It now starts a turn like any
 * other message, with the transcript as its text.
 *
 * Pure. Fetching and transcribing the audio is infrastructure, handed in.
 */

/** The slice of a Slack file this needs. */
export type RawAudioFile = {
  readonly name?: string;
  readonly mimetype?: string;
  readonly subtype?: string;
  readonly url_private?: string;
  readonly size?: number;
};

/** A clip to transcribe. */
export type AudioClip = { readonly name: string; readonly url: string; readonly size?: number };

/** What came of transcribing one clip: its words, or why there are none. */
export type Transcript = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

/** Marks the injected block, so the model (and history) can tell it from typed words. */
export const VOICE_MARKER = "[voice message]";

/** Is this file a recorded clip? Slack's own recorder sets `subtype: "slack_audio"`; an uploaded audio file has an audio mimetype. */
export const isAudioFile = (f: RawAudioFile): boolean =>
  f.subtype === "slack_audio" || (f.mimetype ?? "").toLowerCase().startsWith("audio/");

/** The clips on a message. A clip with no url stays in: it fails to transcribe and says so, rather than vanishing. */
export const audioClipsOf = (files?: readonly RawAudioFile[]): AudioClip[] =>
  (files ?? []).filter(isAudioFile).map((f) => ({
    name: f.name ?? "voice message",
    url: f.url_private ?? "",
    ...(typeof f.size === "number" ? { size: f.size } : {}),
  }));

/** Does the message carry a clip? Without text, that alone makes it worth a turn. */
export const hasAudio = (files?: readonly RawAudioFile[]): boolean => (files ?? []).some(isAudioFile);

/**
 * What the turn is told about a voice message. The reply goes out as text as
 * usual and also as a spoken clip: a person who talks expects to be talked to.
 */
export const VOICE_REPLY_NOTE =
  "This came in as a voice message. Reply in text as usual and also attach a spoken clip of that reply (use your voice-clip skill if you have one).";

/**
 * The message text for a turn: what was typed, then each clip's transcript
 * (or the note that it could not be transcribed - never dropped silently),
 * then the instruction on how to answer.
 */
export const withTranscripts = (typed: string, results: readonly { name: string; transcript: Transcript }[]): string => {
  if (results.length === 0) return typed;
  const blocks = results.map(({ name, transcript }) =>
    transcript.ok
      ? `${VOICE_MARKER} transcript of "${name}" (automatic, may contain errors):\n${transcript.text}`
      : `${VOICE_MARKER} "${name}" could not be transcribed (${transcript.reason}). Say so and ask the person to type it or send it again.`,
  );
  const head = typed.trim();
  return `${head}${head ? "\n\n" : ""}${blocks.join("\n\n")}\n\n${VOICE_REPLY_NOTE}`;
};
