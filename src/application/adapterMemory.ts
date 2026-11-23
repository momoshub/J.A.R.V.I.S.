/**
 * Use cases over the memory adapter: teach, edit by hand, commit, revert, migrate.
 *
 * Every write goes through `commit`, and `commit` runs the gate. The one
 * deliberate asymmetry is the always-on budget: a refine pass must come in
 * under it, a `learn` may exceed it and is told so. Teaching has to stay
 * instant and unrefusable - the moment "remember this" can fail, people stop
 * telling the bot things - while curation is exactly the job of getting back
 * under the line. The budget is a thing refine OWES, not a wall `learn` hits.
 */
import {
  type Adapter,
  CHANNELS_DIR,
  isBlank,
  MANIFEST_FILE,
  matchesGlob,
  NOTES_FILE,
  PEOPLE_DIR,
  adapterRules,
} from "../domain/adapter.ts";
import { ALWAYS_ON_BUDGET, type AdapterCheck, checkAdapterFiles } from "../domain/adapterCheck.ts";
import type { AdapterStore } from "../infrastructure/adapter/adapterStore.ts";
import type { AdapterRevisionRepo } from "../infrastructure/db/adapterRevisionRepo.ts";

/** Heading new facts land under until a refine pass files them properly. */
export const INBOX_HEADING = "## Recently taught";

export type AdapterDeps = {
  readonly store: AdapterStore;
  readonly revisions?: AdapterRevisionRepo;
  readonly clock: () => number;
  readonly budget?: number;
};

export type CommitResult =
  | { readonly ok: true; readonly revision?: number; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly violations: readonly string[] };

/** Where a fact belongs: everywhere, or only around one person or channel. */
export type MemoryTarget =
  | { readonly kind: "global" }
  | { readonly kind: "person"; readonly id: string }
  | { readonly kind: "channel"; readonly id: string };

const fileFor = (target: MemoryTarget): string =>
  target.kind === "person"
    ? `${PEOPLE_DIR}/${target.id}.md`
    : target.kind === "channel"
      ? `${CHANNELS_DIR}/${target.id}.md`
      : NOTES_FILE;

/** The always-on text a proposal would produce, which is what the budget is on. */
const alwaysOnOf = (adapter: Adapter): string =>
  [adapterRules(adapter), isBlank(adapter.notes) ? "" : adapter.notes].filter(Boolean).join("\n\n");

/**
 * Check a proposed tree and, if it passes, write it and record a revision.
 *
 * `enforceBudget` is false for everything but a refine pass - teaching, hand
 * edits, revert and migrate - see the note at the top.
 */
export const commitAdapter = (
  deps: AdapterDeps,
  files: ReadonlyMap<string, string>,
  opts: { reason: string; actor: string; enforceBudget?: boolean; enforceFixed?: boolean },
): CommitResult => {
  const budget = deps.budget ?? ALWAYS_ON_BUDGET;

  // Render the PROPOSAL, not what is live: the budget has to be measured on
  // what the prompt builder would emit after this commit, not before it.
  const before = deps.store.files();

  // The manifest declares its own limits, so a proposal that may rewrite it
  // can lift them. A refine pass is told not to touch these; this is what
  // makes that a rule rather than a request.
  if (opts.enforceFixed) {
    // Loaded only here: a live manifest that stopped parsing must not stop a
    // revert or a hand edit from repairing it.
    const manifest = deps.store.load().manifest;
    const protectedPaths = [...before.keys()].filter(
      (p) => p === "adapter.yaml" || p === "CARD.md" || manifest.fixed.some((f) => matchesGlob(p, f)),
    );
    const changed = protectedPaths.filter((p) => files.get(p) !== before.get(p));
    if (changed.length > 0) {
      return { ok: false, violations: changed.map((p) => `${p} may not be changed by this pass`) };
    }
  }
  let proposed: Adapter;
  try {
    deps.store.write(files);
    proposed = deps.store.load();
  } catch (e) {
    // Best-effort rollback. If putting the old tree back fails too, the disk is
    // in trouble and that is a bigger problem - but it must not replace the
    // error that actually caused this, which is the one worth reporting.
    try {
      deps.store.write(before);
    } catch {
      /* ignored on purpose: never mask the real failure */
    }
    return { ok: false, violations: [e instanceof Error ? e.message : String(e)] };
  }

  // Checked against the manifest the proposal carries: a commit that rewrites
  // the manifest must satisfy its own new limits, or it could narrow them
  // under files already there and leave every later write refused.
  const check: AdapterCheck = checkAdapterFiles(proposed.manifest, files, alwaysOnOf(proposed), budget);
  const overBudget = check.violations.filter((v) => v.includes("always-on block"));
  const hard = check.violations.filter((v) => !v.includes("always-on block"));

  if (hard.length > 0 || (overBudget.length > 0 && opts.enforceBudget !== false)) {
    deps.store.write(before);
    return { ok: false, violations: check.violations };
  }

  const revision = deps.revisions?.record(files, opts.reason, opts.actor, deps.clock());
  return { ok: true, revision: revision?.id, warnings: overBudget };
};

/** The line `rememberFact` writes for a fact, so the two cannot drift apart. */
const bulletOf = (text: string): string => `- ${text.trim().replace(/\n+/g, " ")}`;

/** Put a fact's line under the inbox heading of one file in `files`. */
const addBullet = (files: Map<string, string>, path: string, text: string): void => {
  const current = files.get(path) ?? "";
  const bullet = bulletOf(text);

  let next: string;
  if (current.includes(INBOX_HEADING)) {
    const at = current.indexOf(INBOX_HEADING) + INBOX_HEADING.length;
    const rest = current.slice(at);
    // Straight after the heading, so the newest is first and a refine pass
    // reads them in the order they arrived.
    next = `${current.slice(0, at)}\n${bullet}${rest.replace(/^\n+/, "\n")}`;
  } else {
    const head = current.trim() ? `${current.trimEnd()}\n\n` : "";
    next = `${head}${INBOX_HEADING}\n${bullet}\n`;
  }
  files.set(path, next);
};

/**
 * Append a fact under the inbox heading of whichever files its scope names, in
 * ONE commit: either every file holds it afterwards or none does. A target that
 * already holds the line is skipped, so a retry never doubles it.
 */
export const rememberFactIn = (
  deps: AdapterDeps,
  fact: string,
  targets: readonly MemoryTarget[],
  actor: string,
): CommitResult => {
  const text = fact.trim();
  if (!text) return { ok: false, violations: ["Nothing to remember."] };

  const files = new Map(deps.store.files());
  const missing = targets.filter((t) => !hasFact(deps, text, t));
  if (missing.length === 0) return { ok: true, warnings: [] };
  for (const t of missing) addBullet(files, fileFor(t), text);

  return commitAdapter(deps, files, {
    reason: `learn: ${text.slice(0, 120)}`,
    actor,
    enforceBudget: false,
  });
};

/** Append a fact under the inbox heading of whichever file its scope names. */
export const rememberFact = (
  deps: AdapterDeps,
  fact: string,
  target: MemoryTarget,
  actor: string,
): CommitResult => rememberFactIn(deps, fact, [target], actor);

/** Does the scope's file hold exactly this fact as a line? */
export const hasFact = (deps: AdapterDeps, fact: string, target: MemoryTarget): boolean => {
  const text = fact.trim();
  if (!text) return false;
  const bullet = bulletOf(text);
  return (deps.store.files().get(fileFor(target)) ?? "").split("\n").some((line) => line.trim() === bullet);
};

/**
 * Drop a fact's line from whichever file its scope names, as a NEW revision.
 *
 * The inverse of `rememberFact`, for a learning that is deleted after it was
 * filed: revert cannot do it, because it rolls back TO a revision and would
 * undo every later import and refine with it. Reached by `adapter forget`, because
 * an approved fact has no learnings row left to delete by id. Matches the bullet exactly
 * (ignoring surrounding whitespace, CRLF included), wherever in the file a refine
 * pass moved it, and removes the inbox heading when that was its last line.
 * A fact that is not there is a no-op that records nothing.
 */
export const forgetFact = (
  deps: AdapterDeps,
  fact: string,
  target: MemoryTarget,
  actor: string,
): CommitResult => forgetFactFrom(deps, fact, [fileFor(target)], actor);

/** The channel notes a fact may have been filed into by a scoped approval. */
const channelFiles = (deps: AdapterDeps): string[] =>
  [...deps.store.files().keys()].filter((p) => p.startsWith(`${CHANNELS_DIR}/`));

/** Where an approved fact can live: the global notes and every channel note. */
export const factPaths = (deps: AdapterDeps, fact: string): string[] => {
  const text = fact.trim();
  if (!text) return [];
  const bullet = bulletOf(text);
  const held = (path: string): boolean =>
    (deps.store.files().get(path) ?? "").replace(/\r\n/g, "\n").split("\n").some((line) => line.trim() === bullet);
  return [NOTES_FILE, ...channelFiles(deps)].filter(held);
};

/** Drop a fact from the global notes and every channel note that holds it, in one revision. */
export const forgetFactEverywhere = (deps: AdapterDeps, fact: string, actor: string): CommitResult =>
  forgetFactFrom(deps, fact, factPaths(deps, fact), actor);

const forgetFactFrom = (
  deps: AdapterDeps,
  fact: string,
  paths: readonly string[],
  actor: string,
): CommitResult => {
  const text = fact.trim();
  if (!text) return { ok: true, warnings: [] };
  const files = new Map(deps.store.files());
  const bullet = bulletOf(text);
  let changed = false;
  for (const path of paths) {
    const current = files.get(path);
    if (current === undefined) continue;
    // An imported file may carry CRLF; work on LF so blank runs collapse and the file is rewritten clean.
    const lines = current.replace(/\r\n/g, "\n").split("\n");
    const kept = lines.filter((line) => line.trim() !== bullet);
    if (kept.length === lines.length) continue;
    changed = true;

    // An inbox heading left with nothing under it is noise in every prompt.
    const at = kept.findIndex((line) => line.trim() === INBOX_HEADING);
    if (at !== -1) {
      const next = kept.slice(at + 1).findIndex((line) => line.trim() !== "");
      if (next === -1 || kept[at + 1 + next]?.startsWith("#")) kept.splice(at, 1);
    }
    const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    // The notes file stays, blank: it is the one every scope falls back to.
    if (body === "" && path !== NOTES_FILE) files.delete(path);
    else files.set(path, body === "" ? "" : `${body}\n`);
  }
  if (!changed) return { ok: true, warnings: [] };
  return commitAdapter(deps, files, {
    reason: `forget: ${text.slice(0, 120)}`,
    actor,
    enforceBudget: false,
  });
};

/**
 * One-time move of the flat `learnings` table into the adapter.
 *
 * Everything lands under one heading, unsorted and unmerged, exactly as it was.
 * It is tempting to classify here - this fact is about a person, that one is
 * about a repo - but that is the refine pass's job, done by a model that can
 * read them, and doing it with pattern-matching in a migration would bake a
 * particular instance's vocabulary into a generic codebase.
 *
 * `clear` empties the source once the commit has landed, and it is not
 * optional politeness - two stores of memory means one of them is lying. The
 * first instinct was to leave the table as a fallback, which is wrong twice
 * over: it would restore the pre-curation list, contradictions and all, and it
 * would get staler every day while looking authoritative. The snapshot in
 * revision #1 is the real record of what was migrated.
 */
export const migrateLearnings = (
  deps: AdapterDeps,
  learnings: readonly string[],
  actor: string,
  clear?: () => void,
): CommitResult => {
  const kept = learnings.map((l) => l.trim()).filter(Boolean);
  if (kept.length === 0) return { ok: true, warnings: [] };

  const files = new Map(deps.store.files());
  const current = files.get(NOTES_FILE) ?? "";
  const heading = "## Carried over from the old learnings list";
  const block = `${heading}\n${kept.map((l) => `- ${l}`).join("\n")}\n`;
  files.set(NOTES_FILE, current.trim() ? `${current.trimEnd()}\n\n${block}` : block);

  const result = commitAdapter(deps, files, {
    reason: `migrate ${kept.length} learnings into the adapter`,
    actor,
    enforceBudget: false,
  });
  // Only once it is safely committed, and never on a refusal.
  if (result.ok) clear?.();
  return result;
};

/**
 * The owner rewriting one file by hand, from the dashboard.
 *
 * Same gate as any other write, so a hand edit cannot break the manifest's
 * limits or the format of a skill, and every save is a revision that one
 * click puts back. Like teaching, it may run over the always-on budget and is
 * told so: a person fixing a line should not be refused for the size of a
 * file they did not grow. Blank content removes the file, except the manifest,
 * which nothing loads without. `base` is the text the editor was opened on:
 * when given and the stored file no longer matches it (the bot learned
 * something meanwhile), the save is refused rather than silently undoing that.
 */
export const editAdapterFile = (
  deps: AdapterDeps,
  path: string,
  content: string,
  actor: string,
  base?: string,
  /** The revision's reason; absent says it was a hand edit. */
  reason?: string,
): CommitResult => {
  const rel = path.trim();
  // Canonical paths only. `a/./b` lands on the same mirror file as `a/b` but
  // is a second row in the store, so what runs and what is listed would part.
  if (!rel || rel.includes("\\") || rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return { ok: false, violations: [`Not a path inside the adapter: ${path}`] };
  }
  const files = new Map(deps.store.files());
  // Same reason on a case-insensitive disk (the default on macOS): `Run.sh`
  // beside `run.sh` is two rows and one mirror file.
  // Every folder on the way counts, not just the whole path: `a/Scripts/x`
  // beside `a/scripts/y` shares one folder there, and the next sync deletes
  // whichever name has no exact row.
  const prefixes = (p: string): string[] => p.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const known = new Map<string, string>();
  for (const p of files.keys()) for (const pre of prefixes(p)) known.set(pre.toLowerCase(), pre);
  // A file already stored under this exact path adds no new row, so an old
  // clash (from import or another host) can still be fixed or removed here.
  const clash = files.has(rel)
    ? undefined
    : prefixes(rel)
    .map((pre) => ({ pre, other: known.get(pre.toLowerCase()) }))
    .find(({ pre, other }) => other !== undefined && other !== pre);
  if (clash) return { ok: false, violations: [`${clash.pre} clashes with ${clash.other}, which differs only in case`] };
  // A browser may hand a textarea back with CRLF line ends.
  const lf = (s: string): string => s.replace(/\r\n/g, "\n");
  const text = lf(content);
  // The stored side too: a file imported from disk may still carry CRLF.
  if (base !== undefined && lf(files.get(rel) ?? "") !== lf(base)) {
    return { ok: false, violations: [`${rel} changed since it was opened - reload and redo the edit`] };
  }
  const blank = text.trim() === "";
  if (blank && rel === MANIFEST_FILE) return { ok: false, violations: [`${MANIFEST_FILE} cannot be removed`] };
  if (blank && !files.has(rel)) return { ok: false, violations: [`There is no ${rel} to remove.`] };
  if (!blank && files.get(rel) !== undefined && lf(files.get(rel) ?? "") === text) return { ok: true, warnings: [] };
  if (blank) files.delete(rel);
  else files.set(rel, text);
  return commitAdapter(deps, files, {
    reason: reason ?? `${blank ? "remove" : "edit"} ${rel} by hand`,
    actor,
    enforceBudget: false,
  });
};

/** Restore a previous revision, recording the restore as a revision of its own. */
export const revertAdapter = (deps: AdapterDeps, id: number, actor: string): CommitResult => {
  const target = deps.revisions?.get(id);
  if (!target) return { ok: false, violations: [`There is no revision #${id}.`] };
  return commitAdapter(deps, target.files, {
    reason: `revert to #${id}`,
    actor,
    enforceBudget: false,
  });
};

/**
 * Reads the adapter for the prompt builder, keeping the last good one.
 *
 * The safety net for a manifest that stops parsing is the LAST GOOD READ, not
 * the old learnings table. Falling back to that table was the first instinct
 * and it is wrong twice over: it restores the pre-curation list, contradictions
 * and all, and it goes staler every day while looking authoritative. The last
 * good read is the real memory, minus whatever broke it - and it is the only
 * fallback that cannot quietly serve something months out of date.
 */
export const createAdapterReader = (
  store: Pick<AdapterStore, "exists" | "load">,
  onError: (err: unknown) => void = () => {},
): { read: () => Adapter | undefined } => {
  let lastGood: Adapter | undefined;
  return {
    read: () => {
      if (!store.exists()) return undefined;
      try {
        lastGood = store.load();
        return lastGood;
      } catch (err) {
        onError(err);
        return lastGood;
      }
    },
  };
};

/** A short status line: what the adapter holds and what it costs every turn. */
export const adapterStatus = (deps: AdapterDeps): string => {
  const adapter = deps.store.load();
  const budget = deps.budget ?? ALWAYS_ON_BUDGET;
  const size = new TextEncoder().encode(alwaysOnOf(adapter)).length;
  const scoped = adapter.people.size + adapter.channels.size;
  const over = size > budget ? `  :warning: over the ${budget} budget - run \`adapter refine\`` : "";
  return [
    `*${adapter.manifest.name}* v${adapter.manifest.version} (\`${adapter.manifest.id}\`)`,
    `- always-on: ${size} of ${budget} bytes${over}`,
    `- scoped notes: ${scoped} (${adapter.people.size} people, ${adapter.channels.size} channels)`,
    `- skills: ${adapter.skills.length}`,
  ].join("\n");
};
