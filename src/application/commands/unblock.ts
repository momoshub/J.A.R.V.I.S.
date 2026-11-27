/** `unblock`: a person the bot works for is stuck on something only the owner can give. See domain/jueki.ts. */

import { parseUnblock, unblockKey } from "../../domain/jueki.ts";
import { type CommandDef } from "./shared.ts";

export const UNBLOCK_COMMANDS: readonly CommandDef[] = [
  {
    name: "unblock",
    // Mine alone: refused unless the brain runs it in its own turn, so no role or grant is involved. It runs from the stuck person's thread, as them.
    internal: true,
    minRole: "pal",
    usage: '--thread <slack link> --for <user> --need "<what is blocking them>" [--plan "<what I will do once approved>"]',
    summary: "ask the owner to unblock a person who is stuck, and carry on in their thread once approved",
    run: async ({ deps, actor, channelId, threadTs, messageTs, rest, prefix }) => {
      const jueki = deps.jueki;
      if (!jueki) return "I cannot reach the owner about this right now.";
      const word = rest.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      // Approve / Reject are the owner's button presses, decided in code (application/juekiApproval.ts): a command run in a turn cannot tell a press from an owner turn.
      if (word === "approve" || word === "reject") {
        return "An unblock is approved or rejected only by the owner pressing the button on the DM I sent. Nothing changed.";
      }
      const read = parseUnblock(rest);
      if (!read.ok) return `${read.error}. \`${prefix} unblock --thread <link> --for <user> --need "..." --plan "..."\``;
      const where = read.input.subject;
      // The ask is about THIS thread and, unless the owner runs it, THIS person: an approval starts a turn as the owner in the thread named, so a session cannot point it elsewhere.
      if (where.channelId !== channelId || where.threadTs !== (threadTs || messageTs)) {
        return "`--thread` must be the thread this conversation is in. Nothing was sent.";
      }
      if (actor.slackId !== deps.ownerSlackId && where.forUser !== actor.slackId) {
        return "`--for` must be the person you are talking to. Nothing was sent.";
      }
      if (read.input.subject.forUser === deps.ownerSlackId) return "The owner needs no unblocking from the owner. Nothing was sent.";
      return jueki.blocker({
        key: unblockKey(read.input),
        kind: "unblock",
        text: read.input.need,
        subject: read.input.subject,
        // Nothing here is prod, urgent or a claim of low risk: the owner decides, once, and quiet hours hold it.
        facts: {
          prod: false,
          incident: false,
          customerImpact: false,
          reversible: false,
          dataWrite: false,
          schemaChange: false,
          secretOrIam: false,
          beyondRole: false,
          ownerDecision: true,
        },
      });
    },
  },
];
