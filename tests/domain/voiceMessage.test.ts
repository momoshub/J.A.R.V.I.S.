import { describe, expect, test } from "bun:test";
import { audioClipsOf, hasAudio, isAudioFile, VOICE_MARKER, VOICE_REPLY_NOTE, withTranscripts } from "../../src/domain/voiceMessage.ts";

const clip = { name: "audio_message.m4a", mimetype: "audio/mp4", subtype: "slack_audio", url_private: "https://files.slack.com/files-pri/T1-F1/a.m4a" };

describe("isAudioFile", () => {
  test("a Slack recorded clip and any audio mimetype count, an image or document does not", () => {
    expect(isAudioFile(clip)).toBe(true);
    expect(isAudioFile({ subtype: "slack_audio" })).toBe(true);
    expect(isAudioFile({ mimetype: "audio/webm" })).toBe(true);
    expect(isAudioFile({ mimetype: "image/png" })).toBe(false);
    expect(isAudioFile({ mimetype: "application/pdf" })).toBe(false);
  });
});

describe("audioClipsOf / hasAudio", () => {
  test("only audio files, and a clip with no url stays in so it can fail loudly", () => {
    expect(audioClipsOf([clip, { mimetype: "image/png", url_private: "x" }])).toEqual([{ name: "audio_message.m4a", url: clip.url_private }]);
    expect(audioClipsOf([{ subtype: "slack_audio" }])).toEqual([{ name: "voice message", url: "" }]);
    expect(hasAudio([clip])).toBe(true);
    expect(hasAudio([{ mimetype: "image/png" }])).toBe(false);
    expect(hasAudio(undefined)).toBe(false);
  });
});

describe("withTranscripts", () => {
  test("no clips: the typed text is untouched", () => {
    expect(withTranscripts("hello", [])).toBe("hello");
  });

  test("the transcript goes into the text, marked as a voice message, with the reply instruction", () => {
    const out = withTranscripts("", [{ name: "a.m4a", transcript: { ok: true, text: "what is on my plate today" } }]);
    expect(out).toContain(VOICE_MARKER);
    expect(out).toContain("what is on my plate today");
    expect(out).toContain("automatic, may contain errors");
    expect(out.endsWith(VOICE_REPLY_NOTE)).toBe(true);
  });

  test("the note tells the turn to answer in text AND attach a spoken clip, with no instance names", () => {
    expect(VOICE_REPLY_NOTE).toMatch(/voice message/);
    expect(VOICE_REPLY_NOTE).toMatch(/Reply in text as usual and also attach a spoken clip/);
    expect(VOICE_REPLY_NOTE).not.toMatch(/momos|jarvis/i);
  });

  test("typed words stay in front of the transcript", () => {
    const out = withTranscripts("see this", [{ name: "a.m4a", transcript: { ok: true, text: "hi" } }]);
    expect(out.startsWith("see this\n\n")).toBe(true);
  });

  test("a failed transcript is said, never dropped", () => {
    const out = withTranscripts("", [{ name: "a.m4a", transcript: { ok: false, reason: "transcription timed out" } }]);
    expect(out).toContain("could not be transcribed (transcription timed out)");
    expect(out).toContain(VOICE_REPLY_NOTE);
  });
});
