import { describe, expect, test } from "bun:test";
import { sensitiveWord, touchesSensitive } from "../../src/domain/lowRisk.ts";

describe("sensitiveWord: what keeps a change out of the low-risk lane", () => {
  test("roles, permissions, auth, tickets, tokens, secrets, approvals and prod are caught, any case", () => {
    for (const t of [
      "the role check lets a pal through",
      "Permissions are read twice",
      "authorization header dropped",
      "worker ticket is not revoked",
      "the token is logged",
      "a secret in the env",
      "the approval code skips a check",
      "reads prod data",
      "a migration is needed",
      "delete the row",
    ]) {
      expect(touchesSensitive(t)).toBe(true);
    }
  });

  test("an ordinary UI or text bug is clean, and a word that only contains one is not caught", () => {
    for (const t of [
      "reply posted twice",
      "the digest footer shows the wrong line",
      "dedupe on message ts",
      "the author of the commit is shown",
      "a product name is cut off",
      "dropdown closes on first click",
    ]) {
      expect(touchesSensitive(t)).toBe(false);
    }
  });

  test("names the word it found", () => {
    expect(sensitiveWord("fix the TOKEN refresh")).toBe("token");
    expect(sensitiveWord("nothing here")).toBeUndefined();
  });
});
