/**
 * The bot's own open PRs with their CI and who they wait on, for Jueki
 * (domain/jueki.ts `parseOwnPrs`). Read-only: one `gh pr list` in the repo
 * folder. Never throws: a failed read comes back as `problem`, never as "no PRs".
 */
import { parseOwnPrs, type OwnPr } from "../../domain/jueki.ts";
import type { CommandRunner } from "../llm/backgroundAgents.ts";

const PR_LIMIT = 40;

export type JuekiPrProbe = { scan: () => Promise<{ prs: readonly OwnPr[]; problem?: string }> };

export const createJuekiPrProbe = (config: { gh: CommandRunner; authors: readonly string[] }): JuekiPrProbe => ({
  scan: async () => {
    const out = await config.gh([
      "gh", "pr", "list", "--state", "open", "--limit", String(PR_LIMIT),
      "--json", "number,title,url,isDraft,updatedAt,author,statusCheckRollup,reviewRequests",
    ]);
    const prs = out.code === 0 ? parseOwnPrs(out.stdout, config.authors) : undefined;
    if (!prs) return { prs: [], problem: `open PRs not read (\`gh pr list\` ${(out.stderr.trim() || `exit ${out.code}`).split("\n")[0]?.slice(0, 80)})` };
    return { prs };
  },
});
