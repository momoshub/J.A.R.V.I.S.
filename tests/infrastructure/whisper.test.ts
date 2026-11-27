import { describe, expect, test } from "bun:test";
import { cleanTranscript, createWhisperTranscriber, fetchSlackAudio } from "../../src/infrastructure/system/whisper.ts";

const cfg = { whisperBin: "/w/whisper-cli", modelPath: "/w/model.bin", ffmpegBin: "/w/ffmpeg", timeoutMs: 1000, botToken: "xoxb-test" };
const clip = { name: "a.m4a", url: "https://files.slack.com/files-pri/T1-F1/a.m4a" };
const here = () => true;
const audio = async () => new Uint8Array([1, 2, 3]);

describe("cleanTranscript", () => {
  test("drops timestamps, blank-audio markers and extra whitespace", () => {
    expect(cleanTranscript("[00:00:00.000 --> 00:00:02.000]   xin chào\n\n[00:00:02.000 --> 00:00:03.000]  hello  there\n[BLANK_AUDIO]\n")).toBe("xin chào hello there");
    expect(cleanTranscript(" plain words \n")).toBe("plain words");
  });
});

describe("createWhisperTranscriber", () => {
  test("converts to 16k mono wav, then transcribes with the language auto-detected", async () => {
    const cmds: string[][] = [];
    const t = createWhisperTranscriber(cfg, {
      exists: here,
      fetchAudio: audio,
      run: async (cmd) => {
        cmds.push([...cmd]);
        return { code: 0, stdout: cmd[0] === cfg.whisperBin ? "  hello world \n" : "" };
      },
    });
    expect(await t(clip)).toEqual({ ok: true, text: "hello world" });
    expect(cmds[0]).toContain("16000");
    expect(cmds[0]).toContain("-ac");
    expect(cmds[1]!.join(" ")).toContain("-l auto");
    expect(cmds[1]!.join(" ")).toContain(`-m ${cfg.modelPath}`);
  });

  test("a missing binary or model fails with a reason instead of throwing", async () => {
    const run = async () => ({ code: 0, stdout: "x" });
    const noBin = createWhisperTranscriber(cfg, { exists: (p) => p !== cfg.whisperBin, fetchAudio: audio, run });
    expect(await noBin(clip)).toEqual({ ok: false, reason: "the speech-to-text binary is not installed" });
    const noModel = createWhisperTranscriber(cfg, { exists: (p) => p !== cfg.modelPath, fetchAudio: audio, run });
    expect(await noModel(clip)).toEqual({ ok: false, reason: "the speech-to-text model is not installed" });
  });

  test("a killed whisper run reads as a timeout, a failed conversion and an empty result are named", async () => {
    const run = (whisperCode: number, out = "") => async (cmd: readonly string[]) =>
      cmd[0] === cfg.whisperBin ? { code: whisperCode, stdout: out } : { code: 0, stdout: "" };
    expect(await createWhisperTranscriber(cfg, { exists: here, fetchAudio: audio, run: run(137) })(clip)).toEqual({ ok: false, reason: "transcription timed out" });
    expect(await createWhisperTranscriber(cfg, { exists: here, fetchAudio: audio, run: run(0, "[BLANK_AUDIO]") })(clip)).toEqual({ ok: false, reason: "no speech was found" });
    const badConv = createWhisperTranscriber(cfg, { exists: here, fetchAudio: audio, run: async () => ({ code: 1, stdout: "" }) });
    expect(await badConv(clip)).toEqual({ ok: false, reason: "the audio could not be converted" });
  });

  test("a failed download is a failed transcript, not an exception", async () => {
    const t = createWhisperTranscriber(cfg, {
      exists: here,
      fetchAudio: async () => {
        throw new Error("download failed (http 403)");
      },
      run: async () => ({ code: 0, stdout: "" }),
    });
    expect(await t(clip)).toEqual({ ok: false, reason: "download failed (http 403)" });
    expect(await t({ name: "x", url: "" })).toEqual({ ok: false, reason: "the clip has no download url" });
  });
});

describe("fetchSlackAudio", () => {
  test("sends the token to a Slack file host only, redirects included", async () => {
    await expect(fetchSlackAudio("https://evil.example/files-pri/x", "t", (async () => new Response("x")) as unknown as typeof fetch)).rejects.toThrow("not a Slack file url");
    const calls: string[] = [];
    const doFetch = (async (u: string) => {
      calls.push(u);
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://evil.example/a" } }) : new Response("x");
    }) as unknown as typeof fetch;
    await expect(fetchSlackAudio(clip.url, "t", doFetch)).rejects.toThrow("not a Slack file url");
    expect(calls).toHaveLength(1);
  });

  test("returns the bytes", async () => {
    const bytes = await fetchSlackAudio(clip.url, "t", (async () => new Response(new Uint8Array([9, 9]))) as unknown as typeof fetch);
    expect([...bytes]).toEqual([9, 9]);
  });
});
