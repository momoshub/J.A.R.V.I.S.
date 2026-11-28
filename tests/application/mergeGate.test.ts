import { describe, expect, test } from "bun:test";
import { createGithubActions, type GithubActionDeps } from "../../src/application/githubAppActions.ts";
import { runMergeGate, type MergeGateConfig } from "../../src/application/mergeGate.ts";
import type { AllowedUser } from "../../src/domain/types.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const config: MergeGateConfig = { enabled: true, requiredChecks: ["checks", "gitleaks"], attesters: ["rev"], botLogin: "jarvis[bot]" };

type World = {
  pull?: Record<string, unknown>;
  files?: ({ filename: string; previous_filename?: string } | string)[];
  checks?: { name: string; status: string; conclusion: string | null }[];
  reviews?: { user: { login: string; type?: string }; body: string; commit_id: string }[];
  comments?: { user: { login: string; type?: string }; body: string; created_at?: string; updated_at?: string }[];
  mergeFails?: Error;
};

/** A GitHub stand-in: answers the reads the gate makes and records every call. */
const github = (w: World = {}) => {
  const calls: string[] = [];
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    const slice = <T,>(all: T[]): T[] => all.slice((page - 1) * 100, page * 100);
    if (method === "PUT") {
      if (w.mergeFails) throw w.mergeFails;
      return { merged: true, sha: "merge-commit" };
    }
    if (/\/pulls\/9\/files/.test(path)) return slice((w.files ?? ["src/a.ts"]).map((f) => (typeof f === "string" ? { filename: f } : f)));
    if (/\/check-runs/.test(path)) {
      const runs = w.checks ?? [
        { name: "checks", status: "completed", conclusion: "success" },
        { name: "gitleaks", status: "completed", conclusion: "success" },
      ];
      return { total_count: runs.length, check_runs: slice(runs) };
    }
    if (/\/pulls\/9\/reviews/.test(path)) return slice(w.reviews ?? [{ user: { login: "rev" }, body: "[review round 1]\nVERDICT: clean", commit_id: SHA }]);
    if (/\/issues\/9\/comments/.test(path)) return slice(w.comments ?? [{ user: { login: "rev" }, body: `[verify] ${SHA}\nVERDICT: verified` }]);
    return { state: "open", merged: false, draft: false, head: { sha: SHA }, user: { login: "jarvis[bot]" }, mergeable: true, mergeable_state: "clean", ...w.pull };
  };
  return { request, calls };
};

describe("runMergeGate", () => {
  test("off -> disabled, GitHub never read", async () => {
    const g = github();
    expect(await runMergeGate({ ...config, enabled: false }, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "disabled" });
    expect(g.calls).toEqual([]);
  });

  test("everything holds -> one merge call, pinned to the sha, as a merge commit", async () => {
    const g = github();
    const out = await runMergeGate(config, g.request, "o/r", 9, SHA);
    expect(out).toMatchObject({ decision: "merged", sha: SHA, mergedSha: "merge-commit", runtime: true });
    expect(g.calls.filter((c) => c.startsWith("PUT"))).toEqual([`PUT repos/o/r/pulls/9/merge ${JSON.stringify({ sha: SHA, merge_method: "merge" })}`]);
  });

  test("flowAudit on: no [flow-audit] comment -> refused, no merge call; with a clean one on the head -> merged", async () => {
    const g = github();
    const d = await runMergeGate({ ...config, flowAudit: true }, g.request, "o/r", 9, SHA);
    expect(d).toMatchObject({ decision: "refused" });
    expect(g.calls.some((c) => c.startsWith("PUT"))).toBe(false);
    const audit = `[flow-audit]\nHEAD: ${SHA}\n| 1 | fixed | ${SHA.slice(0, 7)} | SUPPORTED |\nVERDICT: clean`;
    const ok = github({ comments: [{ user: { login: "rev" }, body: `[verify] ${SHA}\nVERDICT: verified` }, { user: { login: "rev" }, body: audit }] });
    expect(await runMergeGate({ ...config, flowAudit: true }, ok.request, "o/r", 9, SHA)).toMatchObject({ decision: "merged" });
    // the flag off: the same PR without an audit merges as before
    expect(await runMergeGate(config, github().request, "o/r", 9, SHA)).toMatchObject({ decision: "merged" });
  });

  test("appVerdicts reads GitHub's user.type: a human reviewer is refused, a bot one merges", async () => {
    const mk = (type: string) =>
      github({
        reviews: [{ user: { login: "rev", type }, body: "[review round 1]\nVERDICT: clean", commit_id: SHA }],
        comments: [{ user: { login: "rev", type }, body: `[verify] ${SHA}\nVERDICT: verified` }],
      });
    const human = mk("User");
    expect(await runMergeGate({ ...config, appVerdicts: true }, human.request, "o/r", 9, SHA)).toMatchObject({ decision: "refused" });
    expect(human.calls.some((c) => c.startsWith("PUT"))).toBe(false);
    expect(await runMergeGate({ ...config, appVerdicts: true }, mk("Bot").request, "o/r", 9, SHA)).toMatchObject({ decision: "merged" });
    expect(await runMergeGate(config, mk("User").request, "o/r", 9, SHA)).toMatchObject({ decision: "merged" });
  });

  test("a red check -> refused, no merge call", async () => {
    const g = github({ checks: [{ name: "checks", status: "completed", conclusion: "failure" }, { name: "gitleaks", status: "completed", conclusion: "success" }] });
    expect(await runMergeGate(config, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "refused" });
    expect(g.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("real shape: GitHub returns a cancelled and a skipped `checks` run next to the green one, and the PR merges", async () => {
    const g = github({
      checks: [
        { name: "checks", status: "completed", conclusion: "success" },
        { name: "gitleaks", status: "completed", conclusion: "success" },
        { name: "checks", status: "completed", conclusion: "cancelled" },
        { name: "gitleaks", status: "completed", conclusion: "success" },
        { name: "checks", status: "completed", conclusion: "skipped" },
        { name: "gitleaks", status: "completed", conclusion: "success" },
      ],
    });
    expect(await runMergeGate(config, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "merged" });
  });

  test("real shape of a head with no pull_request run yet: `checks` only skipped (push run) -> pending, never merged", async () => {
    const g = github({ checks: [{ name: "checks", status: "completed", conclusion: "skipped" }, { name: "gitleaks", status: "completed", conclusion: "success" }] });
    expect(await runMergeGate(config, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "pending" });
    expect(g.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("checks still running -> pending", async () => {
    const g = github({ checks: [{ name: "checks", status: "in_progress", conclusion: null }] });
    expect(await runMergeGate(config, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "pending" });
  });

  test("the writer's own app comment cannot stand in for review or verify", async () => {
    const g = github({ reviews: [], comments: [{ user: { login: "jarvis[bot]" }, body: `[verify] ${SHA}\nVERDICT: verified` }] });
    const out = await runMergeGate(config, g.request, "o/r", 9, SHA);
    expect(out).toMatchObject({ decision: "refused" });
    expect(g.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("a head that moved -> pending, and nothing else is read", async () => {
    const g = github({ pull: { head: { sha: "f".repeat(40) } } });
    expect(await runMergeGate(config, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "pending" });
    expect(g.calls).toEqual(["GET repos/o/r/pulls/9"]);
  });

  test("docs only: no review or verify needed", async () => {
    const g = github({ files: ["README.md"], reviews: [], comments: [] });
    expect(await runMergeGate(config, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "merged", runtime: false });
  });

  test("a rename out of runtime code into docs is still runtime (the old path counts)", async () => {
    const g = github({ files: [{ filename: "docs/old-test.md", previous_filename: "tests/x.test.ts" }], reviews: [], comments: [] });
    const out = await runMergeGate(config, g.request, "o/r", 9, SHA);
    expect(out).toMatchObject({ decision: "refused" });
    expect(g.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("GitHub lists at most 3000 files: fewer files than `changed_files` means runtime code may be hidden, so review and verify are demanded", async () => {
    const g = github({ files: ["README.md"], reviews: [], comments: [], pull: { changed_files: 3001 } });
    const out = await runMergeGate(config, g.request, "o/r", 9, SHA);
    expect(out).toMatchObject({ decision: "refused" });
    expect(g.calls.some((c) => c.startsWith("PUT"))).toBe(false);
    const complete = github({ files: ["README.md"], reviews: [], comments: [], pull: { changed_files: 1 } });
    expect(await runMergeGate(config, complete.request, "o/r", 9, SHA)).toMatchObject({ decision: "merged", runtime: false });
  });

  test("a list that fills the 30-page cap fails closed instead of reading a truncated PR", async () => {
    const g = github({ files: Array.from({ length: 3000 }, (_, i) => `docs/${i}.md`) });
    await expect(runMergeGate(config, g.request, "o/r", 9, SHA)).rejects.toThrow("more than 3000");
  });

  test("an edited [verify] comment refuses, even with an older good one behind it", async () => {
    const g = github({ comments: [{ user: { login: "rev" }, body: `[verify] ${SHA}\nVERDICT: verified`, created_at: "t1", updated_at: "t2" }] });
    expect(await runMergeGate(config, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "refused" });
  });

  test("lists are read page by page (more than 100 files)", async () => {
    const g = github({ files: [...Array.from({ length: 100 }, (_, i) => `docs/${i}.md`), "src/late.ts"], reviews: [], comments: [] });
    // the 101st file is runtime, so with no review the gate refuses: it saw page 2
    expect(await runMergeGate(config, g.request, "o/r", 9, SHA)).toMatchObject({ decision: "refused" });
    expect(g.calls.some((c) => c.includes("/files?per_page=100&page=2"))).toBe(true);
  });

  test("GitHub refusing the merge (the head moved meanwhile) is thrown, not reported as merged", async () => {
    const g = github({ mergeFails: new Error("409 Head branch was modified") });
    await expect(runMergeGate(config, g.request, "o/r", 9, SHA)).rejects.toThrow("409");
  });
});

describe("merge-gate action", () => {
  const setup = (opts: { worker?: { actions: string[] }; mergeGate?: boolean; world?: World; role?: string } = {}) => {
    const g = github(opts.world);
    const audit: { ok: boolean; args: string; result: string }[] = [];
    const deps: GithubActionDeps = {
      clock: () => 1,
      resolve: () => ({ actor: "U1", channel: "C1" }),
      resolveWorker: (t, call) =>
        t !== "jvwk_dead" && (opts.worker?.actions.includes(call.action) || call.action === "ticket-renew")
          ? { ok: true, actor: "U1", channel: "C1", dispatchId: "ctx_w", id: "wk1", push: false }
          : { ok: false, reason: "action" as const, message: `this worker ticket does not allow ${call.action}`, actor: "U1", channel: "C1" },
      users: { get: () => ({ slackId: "U1", role: opts.role ?? "owner", name: "o" }) as unknown as AllowedUser },
      github: {
        installationOfRepo: async () => 7,
        installationToken: async () => "tok",
        mintWorkerToken: async () => ({ token: "w", expiresAt: 1 }),
        revokeInstallationToken: async () => {},
        request: async (_i, method, path, body) => (path.startsWith("users/") ? { id: 1 } : g.request(method, path, body)),
      },
      audit: { add: (e) => void audit.push({ ok: e.ok, args: e.args, result: e.result }) },
      allowedOwners: ["o"],
      slug: "jarvis",
      ...(opts.mergeGate === false ? {} : { mergeGate: { enabled: true, requiredChecks: ["checks", "gitleaks"], attesters: ["rev"] } }),
    };
    return { actions: createGithubActions(deps), g, audit };
  };
  const ask = { action: "merge-gate", repo: "o/r", number: 9, sha: SHA };

  test("a worker ticket that names merge-gate gets the bot's decision, with the app login as the excluded author", async () => {
    const { actions, g, audit } = setup({ worker: { actions: ["merge-gate"] } });
    const out = await actions.run({ ticket: "jvwk_x", ...ask });
    expect(out.github).toMatchObject({ decision: "merged" });
    expect(g.calls.some((c) => c.startsWith("PUT"))).toBe(true);
    expect(audit.at(-1)).toMatchObject({ ok: true, result: "merge-gate merged" });
    expect(audit.at(-1)?.args).toContain("sha=0123456");
  });

  test("a worker ticket without merge-gate (a reviewer's, a verifier's) is refused and nothing is read or merged", async () => {
    const { actions, g } = setup({ worker: { actions: ["comment", "pr-create"] } });
    await expect(actions.run({ ticket: "jvwk_x", ...ask })).rejects.toThrow("does not allow merge-gate");
    expect(g.calls).toEqual([]);
  });

  test("the bot forging its own approval does not pass: comments by <slug>[bot] are not attestations", async () => {
    const { actions, g } = setup({
      worker: { actions: ["merge-gate"] },
      world: { reviews: [], comments: [{ user: { login: "jarvis[bot]" }, body: `[verify] ${SHA}\nVERDICT: verified` }] },
    });
    const out = await actions.run({ ticket: "jvwk_x", ...ask });
    expect(out.github).toMatchObject({ decision: "refused" });
    expect(g.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  test("without MERGE_GATE the action answers disabled and merges nothing", async () => {
    const { actions, g } = setup({ worker: { actions: ["merge-gate"] }, mergeGate: false });
    expect((await actions.run({ ticket: "jvwk_x", ...ask })).github).toMatchObject({ decision: "disabled" });
    expect(g.calls).toEqual([]);
  });

  test("gate off: a writer ticket minted WITHOUT merge-gate (every one before this change) still gets `disabled`, so the script falls back instead of locking out", async () => {
    const { actions, g, audit } = setup({ worker: { actions: ["pr-create", "comment"] }, mergeGate: false });
    expect((await actions.run({ ticket: "jvwk_x", ...ask })).github).toMatchObject({ decision: "disabled" });
    expect(g.calls).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ ok: true, result: "merge-gate disabled" });
  });

  test("gate off: an executer turn (no github:merge-gate grant) also gets `disabled`", async () => {
    const { actions } = setup({ role: "executer", mergeGate: false });
    expect((await actions.run({ ticket: "good", ...ask })).github).toMatchObject({ decision: "disabled" });
  });

  test("gate off still refuses a ticket that is not live: the answer is not handed to anyone", async () => {
    const { actions } = setup({ mergeGate: false });
    await expect(actions.run({ ticket: "jvwk_dead", ...ask })).rejects.toThrow();
  });

  test("gate ON: a ticket without merge-gate is still refused (the opt-in is the point)", async () => {
    const { actions } = setup({ worker: { actions: ["pr-create"] } });
    await expect(actions.run({ ticket: "jvwk_x", ...ask })).rejects.toThrow("does not allow merge-gate");
  });

  test("gate ON: a raw pr-merge is refused for everyone, even the owner's own turn ticket; gate OFF: unchanged", async () => {
    const on = setup();
    await expect(on.actions.run({ ticket: "good", action: "pr-merge", repo: "o/r", number: 9 })).rejects.toThrow("only through merge-gate");
    expect(on.g.calls).toEqual([]);
    const off = setup({ mergeGate: false });
    await expect(off.actions.run({ ticket: "good", action: "pr-merge", repo: "o/r", number: 9 })).resolves.toBeDefined();
    expect(off.g.calls.some((c) => c.startsWith("PUT"))).toBe(true);
  });

  test("a short or missing sha is refused", async () => {
    const { actions } = setup({ worker: { actions: ["merge-gate"] } });
    await expect(actions.run({ ticket: "jvwk_x", ...ask, sha: "abc123" })).rejects.toThrow("40-hex");
    await expect(actions.run({ ticket: "jvwk_x", action: "merge-gate", repo: "o/r", number: 9 })).rejects.toThrow("40-hex");
  });

  test("a worker ticket cannot be granted a raw pr-merge, only the gate", async () => {
    const { actions } = setup({ worker: { actions: ["merge-gate"] } });
    await expect(actions.run({ ticket: "jvwk_x", action: "pr-merge", repo: "o/r", number: 9 })).rejects.toThrow("does not allow pr-merge");
  });
});
