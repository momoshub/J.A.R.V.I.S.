import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { migrate } from "../../src/infrastructure/db/schema.ts";
import { createSkillDraftRepo } from "../../src/infrastructure/db/skillDraftRepo.ts";

const draft = (name: string, fingerprint = `${name}:1`, base?: string) => ({ fingerprint, name, content: `body of ${name}`, base, sourceChannel: "C1", sourceThreadTs: "1.0" });

describe("skill drafts", () => {
  test("a draft is stored pending with its base, and read back", () => {
    const repo = createSkillDraftRepo(openDatabase(":memory:"));
    const d = repo.add(draft("a-skill", "a:1", "old text"), 100);
    expect(repo.get(d.id)).toMatchObject({ name: "a-skill", state: "pending", base: "old text", createdAt: 100, noticeFingerprint: "" });
    expect(repo.add(draft("b-skill"), 100).base).toBeUndefined();
    expect(repo.get(999)).toBeUndefined();
  });

  test("the decision is claimed once", () => {
    const repo = createSkillDraftRepo(openDatabase(":memory:"));
    const d = repo.add(draft("a-skill"), 1);
    expect(repo.decide(d.id, "approved", 5)).toBe(true);
    expect(repo.decide(d.id, "rejected", 6)).toBe(false);
    expect(repo.get(d.id)).toMatchObject({ state: "approved", decidedAt: 5 });
  });

  test("seen remembers every fingerprint, and a rejected or waiting name stays blocked", () => {
    const repo = createSkillDraftRepo(openDatabase(":memory:"));
    const a = repo.add(draft("a-skill"), 1);
    const b = repo.add(draft("b-skill"), 1);
    const c = repo.add(draft("c-skill"), 1);
    repo.decide(a.id, "rejected", 2);
    repo.decide(b.id, "approved", 2);
    expect(repo.seen("a-skill:1") && repo.seen("b-skill:1") && repo.seen("c-skill:1")).toBe(true);
    expect(repo.seen("nope:1")).toBe(false);
    expect(repo.blockedNames().sort()).toEqual(["a-skill", "c-skill"]);
    expect(repo.pending().map((x) => x.id)).toEqual([c.id]);
  });

  test("countSince and discard", () => {
    const repo = createSkillDraftRepo(openDatabase(":memory:"));
    const a = repo.add(draft("a-skill"), 10);
    repo.add(draft("b-skill"), 20);
    expect(repo.countSince(15)).toBe(1);
    repo.discard(a.id);
    expect(repo.get(a.id)).toBeUndefined();
    expect(repo.countSince(0)).toBe(1);
  });

  test("the notice is remembered with its fingerprint", () => {
    const repo = createSkillDraftRepo(openDatabase(":memory:"));
    const d = repo.add(draft("a-skill"), 1);
    repo.setNotice(d.id, "D1", "9.9", "abc");
    expect(repo.get(d.id)).toMatchObject({ noticeChannel: "D1", noticeTs: "9.9", noticeFingerprint: "abc" });
  });

  test("migrating an older database adds the table, and a rerun is a no-op", () => {
    const old = openDatabase(":memory:");
    migrate(old);
    old.exec("DROP TABLE skill_drafts");
    old.exec("PRAGMA user_version = 45");
    migrate(old);
    migrate(old);
    expect(old.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(46);
    expect(createSkillDraftRepo(old).add(draft("a-skill"), 1).id).toBe(1);
  });
});
