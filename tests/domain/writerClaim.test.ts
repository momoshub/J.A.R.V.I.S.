import { describe, expect, test } from "bun:test";
import {
  CLAIM_MAX_MS,
  PENDING_CLAIM_MS,
  claimFindings,
  findingLine,
  parseClaimKey,
  refusalText,
  takeVerdict,
  type ClaimFacts,
} from "../../src/domain/writerClaim.ts";

const claim = (over: Partial<ClaimFacts> = {}): ClaimFacts => ({
  id: 1, key: "bug:23", dispatchId: "ctx_a", channelId: "C1", threadTs: "1.1", actor: "U1", createdAt: 0, ...over,
});

describe("parseClaimKey", () => {
  test("bug, journey and branch keys, one spelling", () => {
    expect(parseClaimKey("bug:23")).toBe("bug:23");
    expect(parseClaimKey("BUG:#023")).toBe("bug:23");
    expect(parseClaimKey("journey:7")).toBe("journey:7");
    expect(parseClaimKey("branch:fix/jueki-digest-vi-usage")).toBe("branch:fix/jueki-digest-vi-usage");
  });

  test("anything else is no key", () => {
    for (const k of ["", "bug:", "bug:x", "pr:3", "branch:", "branch:-rf", "branch:a..b", "bug:1 2"]) expect(parseClaimKey(k)).toBeUndefined();
  });
});

describe("takeVerdict", () => {
  const me = { channelId: "C1", threadTs: "1.1" };
  test("a free key is taken", () => {
    expect(takeVerdict([], me)).toEqual({ ok: true, refresh: false });
  });

  test("a second claimant is refused with the holder", () => {
    const held = claim();
    expect(takeVerdict([held], { channelId: "C2", threadTs: "9.9" })).toEqual({ ok: false, holder: held });
  });

  test("the same thread asking again before its writer started only refreshes its claim", () => {
    expect(takeVerdict([claim({ dispatchId: "" })], me)).toEqual({ ok: true, refresh: true });
  });

  test("the same thread is refused once its writer is bound: one writer, not two from one thread", () => {
    expect(takeVerdict([claim()], me).ok).toBe(false);
  });

  test("the refusal names the dispatch id and the thread", () => {
    const t = refusalText("bug:23", claim(), 5 * 60_000);
    expect(t).toContain("bug:23 is held by worker ctx_a");
    expect(t).toContain("thread C1 1.1");
    expect(t).toContain("5m ago");
  });
});

describe("claimFindings", () => {
  test("a claim whose worker is dead is found, one whose worker is not is left", () => {
    const f = claimFindings([claim(), claim({ id: 2, key: "bug:24", dispatchId: "ctx_b" })], new Set(["ctx_a"]), 1000);
    expect(f).toEqual([{ kind: "dead", claim: claim() }]);
  });

  test("a claim never bound is stale only after the pending window", () => {
    const c = claim({ dispatchId: "" });
    expect(claimFindings([c], new Set(), PENDING_CLAIM_MS - 1)).toEqual([]);
    expect(claimFindings([c], new Set(), PENDING_CLAIM_MS)).toEqual([{ kind: "stale", claim: c }]);
  });

  test("two live claims on one key are two writers on one job", () => {
    const a = claim();
    const b = claim({ id: 2, dispatchId: "ctx_b", threadTs: "2.2" });
    const f = claimFindings([a, b], new Set(), 1000);
    expect(f).toEqual([{ kind: "duplicate", key: "bug:23", claims: [a, b] }]);
    expect(findingLine(f[0]!, 1000)).toContain("two writers on bug:23");
    expect(findingLine(f[0]!, 1000)).toContain("ctx_b");
  });

  test("a claim older than any worker's life is released even with no verdict on its worker", () => {
    expect(claimFindings([claim()], new Set(), CLAIM_MAX_MS)).toEqual([{ kind: "dead", claim: claim() }]);
  });
});
