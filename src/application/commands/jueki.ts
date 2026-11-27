/** `jueki`: how Jueki's own turn records what it did and raises a wall. See domain/jueki.ts. */

import { cleanKey, digestLine, parseBlockerArgs } from "../../domain/jueki.ts";
import { tokenize } from "../../domain/journey.ts";
import { type CommandDef } from "./shared.ts";

export const JUEKI_COMMANDS: readonly CommandDef[] = [
  {
    name: "jueki",
    // Mine alone: only the brain's own turn runs it (never a typed line, a schedule or a watch-fired turn), and only as the owner, so a pal's thread cannot write the owner's digest or raise a blocker as Jueki. Any owner brain turn can, in any thread; `fixed` is therefore tied to a granted self-fix.
    internal: true,
    minRole: "owner",
    ownHelp: true,
    usage:
      'act "<what I did>" | blocker <key> --kind <permission|prod-write|decision|repeat-failure|other> [--prod] [--incident] [--customer-impact] [--deadline-min N] [--reversible] [--data-write] [--schema-change] [--secret-iam] [--beyond-role] [--owner-decision] "<sentence>" | fixed <key> "<what I did>" | status | help',
    summary: "Jueki's own housekeeping: digest line, blocker (low-risk non-prod ones approved by me, the rest put to the owner), prod self-fix report, status",
    run: async ({ deps, actor, rest, prefix }) => {
      const jueki = deps.jueki;
      if (!jueki) return "Jueki is off right now.";
      if (actor.slackId !== deps.ownerSlackId) return "Jueki works for the owner alone. Nothing changed.";
      const tokens = tokenize(rest);
      const sub = (tokens[0] ?? "status").toLowerCase();
      const args = tokens.slice(1);

      if (sub === "help" || sub === "?") {
        return [
          "*jueki* - the owner's housekeeping coordinator (DM only; state in the database, never in a session)",
          `- \`${prefix} jueki act "<what I did>"\` - one line in today's digest`,
          `- \`${prefix} jueki blocker <key> --kind <permission|prod-write|decision|repeat-failure|other> [--prod] [--incident] [--customer-impact] [--deadline-min N] [--reversible] [--data-write] [--schema-change] [--secret-iam] [--beyond-role] [--owner-decision] "<sentence>"\``,
          "  routed in code: a non-prod `--kind other` blocker that is low-risk (`--reversible`, no data write, no schema change, no secret or IAM change, inside the owner's role, no owner decision, and no role, permission, auth, ticket, token, secret, approval or prod word in the sentence) is approved by me and answers `approved`; any other non-prod is put to the owner once; prod is put again until they act; prod that is urgent (incident, customer impact, or a deadline within 2h) AND low-risk (reversible, no data write, no schema change, no secret or IAM change, within the owner's role) answers `self-fix`. A fact not stated is false, `--reversible` included.",
          `- \`${prefix} jueki fixed <key> "<what I did>"\` - report a self-fixed prod item: digest line plus one direct DM line`,
          `- \`${prefix} jueki status\``,
        ].join("\n");
      }
      if (sub === "status") return jueki.status();
      if (sub === "act") {
        const line = digestLine(args.join(" "));
        if (!line) return `Say what you did. \`${prefix} jueki act "<what I did>"\``;
        await jueki.act(line);
        return "Added to today's digest.";
      }
      if (sub === "fixed") {
        const key = cleanKey(args[0] ?? "");
        const line = digestLine(args.slice(1).join(" "));
        if (!key || !line) return `\`${prefix} jueki fixed <key> "<what I did>"\``;
        if (!(await jueki.fixed(key, line))) {
          return `No self-fix was granted for \`${key}\`: it needs a \`${prefix} jueki blocker ${key} --prod ...\` that answered \`self-fix\` in the last 6 hours. Nothing was posted.`;
        }
        return "Reported in the digest and by one direct DM line.";
      }
      if (sub === "blocker") {
        const read = parseBlockerArgs(args);
        if (!read.ok) return `${read.error}. \`${prefix} jueki help\``;
        return jueki.blocker({ key: read.key, kind: read.kind, text: read.text, facts: read.facts });
      }
      return `I do not know \`${sub}\`. \`${prefix} jueki help\``;
    },
  },
];
