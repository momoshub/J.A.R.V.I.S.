import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createWriterClaimRepo } from "../../src/infrastructure/db/writerClaimRepo.ts";

const claim = { key: "bug:1", channelId: "C1", threadTs: "1.1", actor: "U1", createdAt: 100 };

describe("writer claim repo", () => {
  test("a claim is live until released, and a release keeps the row", () => {
    const db = openDatabase(":memory:");
    const repo = createWriterClaimRepo(db);
    const c = repo.add(claim, 100);
    expect(c).toMatchObject({ id: 1, key: "bug:1", dispatchId: "", channelId: "C1" });
    expect(repo.liveOfKey("bug:1")).toHaveLength(1);
    expect(repo.release(c.id, "done", 200)).toBe(true);
    expect(repo.release(c.id, "again", 300)).toBe(false);
    expect(repo.live()).toEqual([]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM writer_claims").get()?.n).toBe(1);
  });

  test("bind sets the dispatch, refresh re-stamps, releaseDispatch frees all of one worker's claims and no others", () => {
    const repo = createWriterClaimRepo(openDatabase(":memory:"));
    const a = repo.add(claim, 100);
    const b = repo.add({ ...claim, key: "branch:fix/x" }, 100);
    const c = repo.add({ ...claim, key: "bug:2" }, 100);
    repo.bind(a.id, "ctx_w");
    repo.bind(b.id, "ctx_w");
    repo.refresh(c.id, 500);
    expect(repo.live().find((x) => x.id === c.id)?.createdAt).toBe(500);
    expect(repo.releaseDispatch("ctx_w", "ended", 600)).toBe(2);
    expect(repo.live().map((x) => x.key)).toEqual(["bug:2"]);
    // an empty dispatch id matches nothing
    expect(repo.releaseDispatch("", "x", 700)).toBe(0);
  });

  test("the schema sets the version", () => {
    const db = openDatabase(":memory:");
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBeGreaterThanOrEqual(55);
  });
});
