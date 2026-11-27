/**
 * The bot's exec proxy: runs `gh` and `orca` for a sandboxed caller.
 *
 * The sandbox (`bin/sandbox/jarvis.sb`) leaves a process with no GitHub login and
 * no way into Orca, so its `gh` and `orca` are shims (`bin/sandbox-shims/`) that
 * send the command line here. The bot - outside the sandbox, holding the real
 * credentials - decides by `domain/proxyPolicy.ts` (what the command is) and the
 * caller's standing (who it is), runs it, and returns the output. The caller
 * proves who it is with one bearer: a turn ticket, a worker ticket, or a session
 * (`domain/sandboxSession.ts`) for a worker that has no ticket.
 *
 * Standing, in short: a session reads GitHub and talks to Orca; a worker ticket
 * adds the GitHub writes it was minted with, on its own repo; a turn ticket adds
 * the writes its role holds, and may use Orca only if the role holds `tools:orca`.
 * Every call is audited (what, never the text) and a refusal says why.
 */
import { isAllowedOwner } from "../domain/githubApp.ts";
import { classifyGh, classifyOrca, type Classified, type Need } from "../domain/proxyPolicy.ts";
import { can, type RoleBook } from "../domain/roles.ts";
import { commandPerm, githubPerm, PERM } from "../domain/permissions.ts";
import { type SessionCheck, isSessionToken, verifySession } from "../domain/sandboxSession.ts";
import type { AllowedUser } from "../domain/types.ts";
import { isWorkerToken } from "../domain/workerTicket.ts";
import type { CommandLogRepo } from "../infrastructure/db/commandLogRepo.ts";
import type { Clock } from "./ports.ts";
import type { WorkerRedeem } from "./workerTickets.ts";

export type ExecRequest = {
  bearer: string;
  tool: "gh" | "orca";
  argv: string[];
  /** Standard input for the command: the body file or spec file the shim read on the caller's side. */
  stdin?: string;
  /** `owner/name` of the clone the caller is in, when it could tell. */
  repoHint?: string;
  /** The caller's Orca terminal handle, so `orca orchestration check` reads the caller's mail. */
  handle?: string;
};

export type ExecResult =
  | { ok: true; code: number; stdout: string; stderr: string }
  | { ok: false; error: string; status: number };

export type CommandRun = { code: number; stdout: string; stderr: string };

export type ExecProxyDeps = {
  clock: Clock;
  /** The session secret, read fresh each call (the file may be created after boot); undefined when there is none. */
  sessionSecret: () => string | undefined;
  /** Who a turn ticket runs as, without spending a use; throws or returns undefined when it is not valid. */
  peekTurn: (token: string) => { actor: string; channel: string } | undefined;
  redeemWorker: (token: string, call: { action: string; repo: string }) => WorkerRedeem;
  users: { get: (slackId: string) => AllowedUser | undefined };
  roles: RoleBook;
  allowedOwners: readonly string[];
  audit: Pick<CommandLogRepo, "add">;
  /** Runs the real command with the bot's credentials. */
  run: (tool: "gh" | "orca", argv: readonly string[], opts: { stdin?: string; env?: Record<string, string> }) => Promise<CommandRun>;
};

type Standing =
  | { kind: "session" }
  | { kind: "turn"; actor: string; channel: string; user: AllowedUser }
  | { kind: "worker"; actor: string; channel: string; user: AllowedUser; id: string; dispatchId: string };

const refuse = (status: number, error: string): ExecResult => ({ ok: false, status, error });
const sessionWhy = (r: Extract<SessionCheck, { ok: false }>): string =>
  r.reason === "expired" ? "this sandbox session has expired: start the process again through bin/sandboxed.sh" : "that is not a valid sandbox session or ticket";

export const createExecProxy = (deps: ExecProxyDeps): { handle: (req: ExecRequest) => Promise<ExecResult> } => {
  /** Who is calling, and may they do `need` on `repo`? A reason when not. */
  const standing = (req: ExecRequest, need: Need, repo: string | undefined): Standing | { error: string; status: number } => {
    const bearer = req.bearer.trim();
    if (!bearer) return { status: 401, error: "no ticket or session: this command needs one (run it through bin/sandboxed.sh)" };
    if (isSessionToken(bearer)) {
      const secret = deps.sessionSecret();
      if (!secret) return { status: 503, error: "the bot has no sandbox session secret yet" };
      const check = verifySession(secret, bearer, Math.floor(deps.clock() / 1000));
      if (!check.ok) return { status: 403, error: sessionWhy(check) };
      if (need.kind === "write") return { status: 403, error: `a bare session cannot write to GitHub (${need.action}): it needs a ticket that carries \`${need.action}\`` };
      return { kind: "session" };
    }
    // `ticket-renew` is allowed to every live worker ticket on its own repo: the way to ask "is this ticket live and for this repo".
    const action = need.kind === "write" ? need.action : "ticket-renew";
    if (isWorkerToken(bearer)) {
      if (need.kind === "orca") return { status: 403, error: "orca is reached with the sandbox session, not a worker ticket" };
      const redeemed = deps.redeemWorker(bearer, { action, repo: repo ?? "" });
      if (!redeemed.ok) return { status: 403, error: redeemed.message };
      const user = deps.users.get(redeemed.actor);
      if (!user) return { status: 403, error: "whoever minted this ticket is not on the access list" };
      // A worker keeps working only while its minter may still mint one (same rule as bin/github-app.sh).
      if (!can(deps.roles, user.role, commandPerm("worker-ticket"))) return { status: 403, error: "a worker ticket only works while whoever minted it still holds the worker-ticket grant" };
      if (need.kind === "write" && !can(deps.roles, user.role, githubPerm(need.action))) return { status: 403, error: `the role that minted this ticket may not ${need.action}` };
      return { kind: "worker", actor: redeemed.actor, channel: redeemed.channel, user, id: redeemed.id, dispatchId: redeemed.dispatchId };
    }
    let turn: { actor: string; channel: string } | undefined;
    try {
      turn = deps.peekTurn(bearer);
    } catch {
      turn = undefined;
    }
    if (!turn) return { status: 403, error: "that ticket is not valid any more" };
    const user = deps.users.get(turn.actor);
    if (!user) return { status: 403, error: "whoever asked is not on the access list" };
    if (need.kind === "write" && !can(deps.roles, user.role, githubPerm(need.action))) return { status: 403, error: `the ${user.role} role may not ${need.action} on GitHub (needs \`${githubPerm(need.action)}\`)` };
    if (need.kind === "orca" && !can(deps.roles, user.role, PERM.orca)) return { status: 403, error: `the ${user.role} role may not use Orca (needs \`${PERM.orca}\`)` };
    return { kind: "turn", actor: turn.actor, channel: turn.channel, user };
  };

  const audit = (who: Standing | undefined, c: Classified & { ok: true }, ok: boolean, result: string): void => {
    try {
      deps.audit.add(
        {
          slackUserId: who && who.kind !== "session" ? who.actor : "sandbox-session",
          command: `proxy-${c.tool}`,
          args: `${c.label}${who?.kind === "worker" ? ` worker=${who.dispatchId} t=${who.id}` : ""}`,
          channelId: who && who.kind !== "session" ? who.channel : "",
          ok,
          result: result.slice(0, 300),
        },
        deps.clock(),
      );
    } catch {
      // an audit failure never decides the call
    }
  };

  return {
    handle: async (req) => {
      const argv = Array.isArray(req.argv) && req.argv.every((a) => typeof a === "string") ? req.argv : undefined;
      if (!argv) return refuse(400, "argv must be a list of strings");
      const classified = req.tool === "gh" ? classifyGh(argv, req.repoHint) : req.tool === "orca" ? classifyOrca(argv) : undefined;
      if (!classified) return refuse(400, "tool must be gh or orca");
      if (!classified.ok) return refuse(403, classified.error);
      if (classified.repo) {
        const owner = classified.repo.split("/")[0] ?? "";
        if (!isAllowedOwner(owner, deps.allowedOwners)) return refuse(403, `${owner} is not in GITHUB_APP_ALLOWED_OWNERS, so the proxy will not act there`);
      }
      const who = standing(req, classified.need, classified.repo);
      if ("error" in who) {
        audit(undefined, classified, false, who.error);
        return refuse(who.status, who.error);
      }
      const env: Record<string, string> = {};
      if (classified.tool === "orca" && req.handle && /^term_[\w-]+$/.test(req.handle)) env.ORCA_TERMINAL_HANDLE = req.handle;
      try {
        const out = await deps.run(classified.tool, classified.argv, { ...(req.stdin !== undefined ? { stdin: req.stdin } : {}), env });
        audit(who, classified, out.code === 0, out.code === 0 ? "ok" : `exit ${out.code}`);
        return { ok: true, ...out };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        audit(who, classified, false, message);
        return refuse(502, message);
      }
    },
  };
};
