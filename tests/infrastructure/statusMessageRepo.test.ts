import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createStatusMessageRepo } from "../../src/infrastructure/db/statusMessageRepo.ts";

describe("status message repo", () => {
  test("a posted message is remembered until it is removed", () => {
    const repo = createStatusMessageRepo(openDatabase(":memory:"));
    repo.add("C1", "1.1", 10);
    repo.add("C1", "1.2", 5);
    expect(repo.list()).toEqual([
      { channelId: "C1", ts: "1.2", createdAt: 5 },
      { channelId: "C1", ts: "1.1", createdAt: 10 },
    ]);
    repo.remove("C1", "1.2");
    expect(repo.list().map((r) => r.ts)).toEqual(["1.1"]);
  });

  test("adding twice is one row, and a ts is only its channel's", () => {
    const repo = createStatusMessageRepo(openDatabase(":memory:"));
    repo.add("C1", "1.1", 1);
    repo.add("C1", "1.1", 2);
    repo.add("C2", "1.1", 3);
    expect(repo.list()).toHaveLength(2);
    repo.remove("C2", "9.9");
    expect(repo.list()).toHaveLength(2);
  });

  test("it survives a restart", () => {
    const db = openDatabase(":memory:");
    createStatusMessageRepo(db).add("C1", "1.1", 1);
    expect(createStatusMessageRepo(db).list()).toHaveLength(1);
  });
});
