import { describe, expect, test } from "bun:test";
import { textWithVoice } from "../../src/application/voiceTranscript.ts";
import { VOICE_MARKER, VOICE_REPLY_NOTE } from "../../src/domain/voiceMessage.ts";

const files = [{ name: "audio_message.m4a", mimetype: "audio/mp4", subtype: "slack_audio", url_private: "https://files.slack.com/files-pri/T1-F1/a.m4a" }];

describe("textWithVoice", () => {
  test("an audio-only message gets its transcript as text", async () => {
    const seen: string[] = [];
    const text = await textWithVoice("", files, async (c) => {
      seen.push(c.url);
      return { ok: true, text: "remind me to call back" };
    });
    expect(seen).toEqual([files[0]!.url_private]);
    expect(text).toContain(VOICE_MARKER);
    expect(text).toContain("remind me to call back");
    expect(text).toContain(VOICE_REPLY_NOTE);
  });

  test("a message without audio is returned as it was and nothing is transcribed", async () => {
    let called = false;
    const text = await textWithVoice("hi", [{ mimetype: "image/png", url_private: "x" }], async () => {
      called = true;
      return { ok: true, text: "" };
    });
    expect(text).toBe("hi");
    expect(called).toBe(false);
  });

  test("a failed transcription still yields a turn, with a note that the audio could not be transcribed", async () => {
    const text = await textWithVoice("", files, async () => ({ ok: false, reason: "the speech-to-text model is not installed" }));
    expect(text).toContain("could not be transcribed (the speech-to-text model is not installed)");
  });

  test("a transcriber that throws is caught, logged and noted", async () => {
    const logs: string[] = [];
    const text = await textWithVoice(
      "",
      files,
      async () => {
        throw new Error("boom");
      },
      (l) => logs.push(l),
    );
    expect(text).toContain("could not be transcribed (boom)");
    expect(logs[0]).toContain("boom");
  });

  test("no transcriber configured: noted, not dropped", async () => {
    const text = await textWithVoice("", files, undefined);
    expect(text).toContain("could not be transcribed (transcription is not set up)");
  });
});
