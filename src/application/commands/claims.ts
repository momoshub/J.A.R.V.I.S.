/** `claim`: one writer per job. See domain/writerClaim.ts. */

import { holderLine, parseClaimKey } from "../../domain/writerClaim.ts";
import { type CommandDef } from "./shared.ts";

export const CLAIM_COMMANDS: readonly CommandDef[] = [
  {
    name: "claim",
    // Mine alone, like `journey`: the brain checks it before it starts a writer; there is nothing here for a person to run.
    internal: true,
    minRole: "pal",
    ownHelp: true,
    quiet: true,
    usage: "take <key>... | bind <ctx_...> <key>... | release <key> [--force] | list | help",
    summary: "one writer per job: take a bug:/journey:/branch: key before worker-start, bind it to the dispatch, see who holds what",
    run: ({ deps, actor, channelId, threadTs, args, prefix }) => {
      const claims = deps.writerClaims;
      if (!claims) return "I keep no claims right now, so nothing stops a second writer: check `journey list` and Orca's tasks by hand.";
      const sub = (args[0] ?? "list").toLowerCase();
      const who = { channelId, threadTs: threadTs ?? "", actor: actor.slackId };
      const keysOf = (words: readonly string[]): { keys: string[] } | { error: string } => {
        const keys: string[] = [];
        for (const w of words) {
          const k = parseClaimKey(w);
          if (!k) return { error: `\`${w}\` is not a job key: \`bug:<id>\`, \`journey:<id>\` or \`branch:<name>\`` };
          if (!keys.includes(k)) keys.push(k);
        }
        return keys.length > 0 ? { keys } : { error: "name the job: `bug:<id>`, `journey:<id>` or `branch:<name>`" };
      };

      if (sub === "help" || sub === "?") {
        return [
          "*claim* - one writer per job; check it before every `worker-start` that writes code",
          `- \`${prefix} claim take bug:23 branch:fix/x\` - before the writer starts: every key or none. Refused when another thread or worker holds one (the answer names its dispatch id and thread): do not start a second writer, follow that one`,
          `- \`${prefix} claim bind <ctx_...> bug:23 branch:fix/x\` - right after \`worker-start\` printed the dispatch id (a claim never bound is released after 30 minutes)`,
          `- \`${prefix} claim release <key>\` - the holding thread ends its claim early (the owner adds \`--force\`). Otherwise it is released when the worker ends or dies, by the watch on it or the coordinator's tick`,
          `- \`${prefix} claim list\``,
        ].join("\n");
      }
      if (sub === "list") {
        const live = claims.live();
        const now = deps.clock();
        return live.length === 0 ? "No live claims." : live.map((c) => `- ${c.key}: ${holderLine(c, now)}`).join("\n");
      }
      if (sub === "take") {
        const read = keysOf(args.slice(1));
        if ("error" in read) return `${read.error}. \`${prefix} claim help\``;
        const r = claims.take(read.keys, who);
        return r.ok
          ? `Claimed ${read.keys.join(", ")}. Start the writer now, then \`${prefix} claim bind <ctx_...> ${read.keys.join(" ")}\` with the dispatch id it prints (a claim never bound is released after 30 minutes).`
          : r.error;
      }
      if (sub === "bind") {
        const dispatch = args[1] ?? "";
        if (!/^ctx_[A-Za-z0-9_-]+$/.test(dispatch)) return `\`${prefix} claim bind <ctx_...> <key>...\``;
        const read = keysOf(args.slice(2));
        if ("error" in read) return `${read.error}. \`${prefix} claim help\``;
        const r = claims.bind(read.keys, dispatch, who);
        return r.ok ? `Bound ${read.keys.join(", ")} to ${dispatch}: released when that worker ends or dies.` : r.error;
      }
      if (sub === "release") {
        const force = args.includes("--force");
        const read = keysOf(args.slice(1).filter((a) => a !== "--force"));
        if ("error" in read) return `${read.error}. \`${prefix} claim help\``;
        if (force && actor.slackId !== deps.ownerSlackId) return "Only the owner force-releases a claim.";
        const out = read.keys.map((k) => {
          const r = claims.release(k, who, force);
          return r.ok ? `Released ${k}.` : r.error;
        });
        return out.join("\n");
      }
      return `I do not know \`${sub}\`. \`${prefix} claim help\``;
    },
  },
];
