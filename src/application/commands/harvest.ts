/** `harvest`: switch the learning harvest on or off and say what it has proposed. See application/learningHarvest.ts. */

import { HARVEST_PER_DAY, HARVEST_SOURCE } from "../../domain/harvest.ts";
import { PERM } from "../../domain/permissions.ts";
import { SETTING_KEYS } from "../../infrastructure/db/settingsRepo.ts";
import { type CommandDef } from "./shared.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const HARVEST_COMMANDS: readonly CommandDef[] = [
  {
    name: "harvest",
    minRole: "pal",
    usage: "[status] | on | off",
    summary: "whether I review my recent conversations and propose facts and skills to remember (off by default; the owner approves every one)",
    run: ({ can, deps, args, prefix }) => {
      const settings = deps.settings;
      if (!settings) return "I have nowhere to keep settings right now.";
      const sub = (args[0] ?? "status").toLowerCase();
      const on = () => settings.get(SETTING_KEYS.learningHarvest)?.trim().toLowerCase() === "on";

      if (sub === "status") {
        const cursor = Number(settings.get(SETTING_KEYS.learningHarvestCursor));
        const since = Date.now() - DAY_MS;
        const facts = deps.learnings?.all().filter((l) => l.createdBy === HARVEST_SOURCE && l.createdAt >= since).length;
        const drafts = deps.skillDrafts?.countSince(since);
        const waiting = deps.skillDrafts?.pending().length;
        return [
          on() ? "learning harvest is *on*" : `learning harvest is *off* - \`${prefix} harvest on\` lets me propose what to remember; nothing is saved until the owner approves it`,
          ...(facts === undefined || drafts === undefined ? [] : [`proposed in the last day: ${facts + drafts} of at most ${HARVEST_PER_DAY}`]),
          ...(waiting === undefined ? [] : [`skill drafts waiting for the owner: ${waiting}`]),
          ...(Number.isFinite(cursor) && cursor > 0 ? [`last read up to: ${new Date(cursor).toISOString()}`] : []),
        ].join("\n");
      }

      if (sub === "on" || sub === "off") {
        if (!can(PERM.manageSettings)) return "You are not allowed to switch the learning harvest.";
        if (sub === "off") {
          settings.set(SETTING_KEYS.learningHarvest, "off");
          return "learning harvest off - I stop reviewing my conversations; proposals already waiting still wait for the owner";
        }
        settings.set(SETTING_KEYS.learningHarvest, "on");
        // Resume from now: whatever was said while it was off is not read.
        settings.set(SETTING_KEYS.learningHarvestCursor, String(Date.now()));
        return "learning harvest on - from now on I review my conversations and propose facts and skills to the owner, who approves or rejects each one";
      }

      return `Unknown option. Usage: \`${prefix} harvest [status] | on | off\``;
    },
  },
];
