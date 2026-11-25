import { describe, expect, test } from "bun:test";
import { endsInNoReply, isSilenceNote } from "../../src/domain/silence.ts";

describe("isSilenceNote", () => {
  test("the placeholder that actually got posted is caught", () => {
    expect(isSilenceNote("(empty reply — nothing to add here)")).toBe(true);
  });

  test("other ways of announcing silence are caught", () => {
    for (const t of ["_no reply needed_", "Nothing to add.", "(staying quiet)", "no response", "*silence*", "NO_REPLY", "`NO_REPLY`"]) {
      expect(isSilenceNote(t)).toBe(true);
    }
  });

  test("a real answer is never swallowed", () => {
    for (const t of [
      "",
      "done, the PG side is applied on sg-stg",
      "nothing to add from me, but the index is missing on sg-stg - see `role_assignment_brands`, it still has no unique (account_id, id) index",
      "no, that one is for the team-a pod",
    ]) {
      expect(isSilenceNote(t)).toBe(false);
    }
  });
});

describe("isSilenceNote: react-only narration and NO_REPLY", () => {
  test("the leaked sentence and its variants are caught", () => {
    for (const t of [
      "I added a reaction and posted no reply.",
      "I added a reaction and posted no reply",
      "reacted, no reply needed",
      "Reacted only, no reply",
      "just reacting here",
      "(reacted, staying quiet)",
      "I reacted with 👍 and said nothing else.",
      "I left a :thumbsup: reaction, nothing to add",
      "_I've added a reaction; no reply needed._",
    ]) {
      expect(isSilenceNote(t)).toBe(true);
    }
  });

  test("a reply that ends in NO_REPLY is dropped, however much narration comes first", () => {
    for (const t of [
      "I added a reaction to the message, so there is nothing to post in the thread.\n\nNO_REPLY",
      "Reacted to the thanks. NO_REPLY",
      "Looked at the thread and the owner already answered, so I only reacted.\n`NO_REPLY`",
    ]) {
      expect(isSilenceNote(t)).toBe(true);
      expect(endsInNoReply(t)).toBe(true);
    }
  });

  test("real answers that mention a reaction or the word are still posted", () => {
    for (const t of [
      "I added a reaction to the PR comment, and the build is green now.",
      "I added a 👍 reaction to your message as you asked - anything else?",
      "Reacted to the wrong message, fixed it: the ✅ is now on the deploy post.",
      "The bot posts NO_REPLY when it has nothing to say, so that is why the thread stayed empty. Want me to change that?",
      "Reactions are added with reactions.add, one call per emoji.",
    ]) {
      expect(isSilenceNote(t)).toBe(false);
      expect(endsInNoReply(t)).toBe(false);
    }
  });
});
