import { describe, expect, test } from "bun:test";
import {
  asAgentCap,
  DEFAULT_REVIEW_AGENTS,
  REVIEW_AGENT_CEILING,
  reviewHelp,
  reviewPrompt,
} from "../../src/domain/reviewPrompt.ts";

const PR = "https://github.com/o/r/pull/1";

describe("asAgentCap", () => {
  test("accepts a sane count", () => {
    expect(asAgentCap("1")).toBe(1);
    expect(asAgentCap(" 5 ")).toBe(5);
    expect(asAgentCap(String(REVIEW_AGENT_CEILING))).toBe(REVIEW_AGENT_CEILING);
  });

  test("refuses anything that is not one, so the caller falls back", () => {
    expect(asAgentCap(undefined)).toBeUndefined();
    expect(asAgentCap("")).toBeUndefined();
    expect(asAgentCap("0")).toBeUndefined();
    expect(asAgentCap("-2")).toBeUndefined();
    expect(asAgentCap("2.5")).toBeUndefined();
    expect(asAgentCap("lots")).toBeUndefined();
    // nobody configures their way back to an unbounded fan-out
    expect(asAgentCap(String(REVIEW_AGENT_CEILING + 1))).toBeUndefined();
  });
});

describe("reviewPrompt fan-out", () => {
  test("caps child agents at the default and spawns them in one batch", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(DEFAULT_REVIEW_AGENTS).toBe(3);
    expect(p).toContain(`at most ${DEFAULT_REVIEW_AGENTS} child agents`);
    expect(p).toContain("in ONE batch");
    expect(p).toContain("Never a second round");
  });

  test("a configured cap replaces it", () => {
    expect(reviewPrompt([PR], "Bot", undefined, [PR], 5)).toContain("at most 5 child agents");
  });

  test("a cap of one does not tell the brain to avoid one agent at a time", () => {
    // the plural wording contradicts itself at 1: "at most 1 agent, in one
    // parallel batch, never one agent at a time"
    const p = reviewPrompt([PR], "Bot", undefined, [PR], 1);
    expect(p).toContain("exactly ONE child agent");
    expect(p).not.toContain("one agent at a time");
    expect(p).not.toContain("in parallel. Never a second round");
  });

  test("an unfinished agent never holds the review hostage", () => {
    // the failure this exists for: a run that waits out its whole budget on one
    // agent and times out having posted nothing
    expect(reviewPrompt([PR], "Bot")).toContain("drop it and post the review with what you have");
  });

  test("a late agent's blocking finding is posted, never raised as a question", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("LATE FINDING");
    expect(p).toContain("post ONE short follow-up comment");
    expect(p).toContain("Never hold a verified blocker back");
  });

  test("it decides instead of asking - nobody is there to answer", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("Decide, never ask");
    expect(p).toContain('Never end on "say the word"');
    expect(p).toContain("or close on a question");
  });

  test("no running commentary - the thread gets progress lines already", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("Work quietly");
    expect(p).toContain('no "waiting on the agents"');
  });

  test("the asker's note aims the review without loosening it", () => {
    const p = reviewPrompt([PR], "Bot", undefined, [PR], 3, "the migration is the risky bit");
    expect(p).toContain("the migration is the risky bit");
    expect(p).toContain("What the person asking wants you to look at");
    // it steers, it does not govern
    expect(p).toContain("It does not change anything else in this brief");
    expect(p).toContain("never a reason to skip a PR");
  });

  test("no note means no section at all", () => {
    for (const empty of [undefined, "", "   "]) {
      expect(reviewPrompt([PR], "Bot", undefined, [PR], 3, empty)).not.toContain("in their words");
    }
  });

  test("a note asking for something outside a PR review is refused, out loud", () => {
    const p = reviewPrompt([PR], "Bot", undefined, [PR], 3, "also merge it and deploy");
    expect(p).toContain("ignore that part and say so");
  });
});

describe("reviewPrompt comment shape", () => {
  test("a verdict line, then blockers and non-blocking findings as separate groups, worst first", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain('line 1: where you land, "good to merge" or what blocks');
    expect(p).toContain('each opened by a bare line "blockers" or "non-blocking"');
    expect(p).toContain('one "- " bullet per finding, worst first');
    expect(p).toContain("Blockers first, then non-blocking, then the out-of-scope bullet last");
  });

  test("a clean PR gets one line", () => {
    expect(reviewPrompt([PR], "Bot")).toContain("A clean PR gets this line and the sign-off, nothing else");
  });

  test("every PR gets the non-blocking findings, whoever owns it", () => {
    for (const url of [PR, "https://github.com/any-owner/any-repo/pull/9", "acme/api#7"]) {
      const p = reviewPrompt([url], "Bot");
      expect(p).toContain("NON-BLOCKING findings (design risk, correctness doubts, coding style, real cleanups) go in the comment too");
      expect(p).toContain("Pure-noise nits are dropped");
    }
  });

  test("non-blocking findings never flip the review and never become an issue", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("They never make flow B and never become an issue");
    expect(p).toContain("Never open an issue");
    expect(p).not.toContain("gh issue create");
    expect(p).not.toContain("never go in the comment");
  });

  test("a declared gap is a last warning bullet, never a blocker, but what the PR breaks is not excused", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain('ONE last bullet, "out of scope per the description: ... risk left standing"');
    expect(p).toContain("A warning only, never blocking");
    expect(p).toContain("A problem the PR itself introduces is not out of scope");
  });

  test("known content is not said again, and it is read first", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("READ the description and every existing comment before you review");
    expect(p).toContain("no summary of the diff");
  });

  test("it points at the code rather than reproducing it", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("ONE pointer");
    expect(p).toContain("Never paste code");
  });

  test("failing CI blocks, and nothing unverified is raised", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("or failing CI");
    expect(p).toContain("never fabricate");
  });

  test("the prompt stays lean", () => {
    // the owner asked for a token-efficient prompt; it was ~12.6k chars once, ~6k blockers-only
    const p = reviewPrompt([PR], "Bot", { login: "kai", name: "Kai" });
    expect(p.length).toBeLessThan(7500);
  });
});

describe("reviewPrompt coverage", () => {
  test("every changed file and hunk is read, never a sample, and callers and callees are followed", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("trace ALL of the diff, never a sample");
    expect(p).toContain("Every changed file and every hunk is read");
    expect(p).toContain("callers and callees of each changed symbol are followed in the real code");
    expect(p).toContain("Not big: read every hunk yourself");
  });

  test("on a big PR every file goes to exactly one child agent, and the reviewer covers the rest", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("EVERY file is assigned to exactly ONE agent");
    expect(p).toContain("tell each agent its files by name");
    expect(p).toContain("You cover whatever no agent was assigned or reported back on");
    // a lone agent still gets the whole list, the reviewer checks what it missed
    expect(reviewPrompt([PR], "Bot", undefined, [PR], 1)).toContain("given the whole file list");
  });

  test("the comment never claims coverage it did not do, and names what could not be read in one line", () => {
    const p = reviewPrompt([PR], "Bot");
    expect(p).toContain("Never claim coverage you did not do");
    expect(p).toContain('"not read: <file> (<why>)"');
    expect(p).toContain("a binary, a huge generated file");
    expect(p).toContain("and what was not read if anything");
  });
});

describe("reviewPrompt rounds", () => {
  const round = { number: 2, from: "a".repeat(40), to: "b".repeat(40) };
  const build = (r?: typeof round) => reviewPrompt([PR], "Bot", { login: "kai", name: "Kai" }, [], 3, undefined, [], "human", r);

  test("a round says which round it is, and reviews the delta in the context of the whole PR", () => {
    const p = build(round);
    expect(p).toContain("THIS IS ROUND 2");
    expect(p).toContain("DELTA aaaaaaa..bbbbbbb");
    expect(p).toContain(`compare/${round.from}...${round.to}`);
    expect(p).toContain("read in the context of the whole PR");
    expect(p).toContain("BIG is judged on the delta too");
  });

  test("line 1 starts with the round, and each earlier blocker is fixed, still open or new", () => {
    const p = build(round);
    expect(p).toContain('line 1 starts with "round 2 (aaaaaaa..bbbbbbb)"');
    expect(p).toContain("whether the new commits fixed it");
    expect(p).toContain('"still open from round 1:"');
    expect(p).toContain("New findings follow in their groups");
  });

  test("a round with nothing blocking left is still flow A", () => {
    expect(build(round)).toContain("A round with no blocker left is flow A");
  });

  test("a first review has no round text at all", () => {
    const p = build(undefined);
    expect(p).not.toContain("ROUND");
    expect(p).not.toContain("DELTA");
    expect(p).not.toContain("still open from round");
  });

  test("the round prompt stays lean too", () => {
    expect(build(round).length).toBeLessThan(8500);
  });

  test("red CI on the new head works the same per round", () => {
    const p = reviewPrompt([PR], "Bot", undefined, [], 3, undefined, [PR], "human", round);
    expect(p).toContain("change request ALREADY submitted");
    expect(p).toContain("THIS IS ROUND 2");
  });
});

describe("reviewHelp", () => {
  test("the help names quick-review and says when it runs: a person asks, or a review is requested on GitHub", () => {
    const h = reviewHelp("//bot", false, 3, "Bot");
    expect(h).toContain("`//bot quick-review <pr-url>`");
    expect(h).toContain("`review <pr-url>` / `approve <pr-url>`");
    expect(h).toContain("when a person asks");
    expect(h).toContain("requested from me on GitHub");
    expect(h).toContain("the approval is the GitHub account's, never the app's");
    expect(h).toContain("`//bot quick-review prompt`");
  });

  test("it says blockers and non-blocking findings both go in the comment, for every PR", () => {
    const h = reviewHelp("X", false, 3, "Bot");
    expect(h).toContain("then lists the blockers, then the non-blocking findings");
    expect(h).toContain('"out of scope per the description"');
    expect(h).toContain("non-blocking findings never make me request changes and never become an issue");
    expect(h).not.toContain("REVIEW_EXTENDED_OWNERS");
    expect(h).not.toContain("blockers only");
  });

  test("it says all of the diff is traced and the child agents split the file list", () => {
    const h = reviewHelp("X", false, 3, "Bot");
    expect(h).toContain("I trace all of the diff, never a sample");
    expect(h).toContain("every file belongs to exactly one of them");
    expect(h).toContain("I never claim coverage I did not do");
  });

  test("it explains the rounds, with their limits, and no longer says a push needs asking again", () => {
    const h = reviewHelp("X", false, 3, "Bot");
    expect(h).toContain("a new commit pushed to it gets the next round by itself");
    expect(h).toContain("still for 2 minutes");
    expect(h).toContain("I stop after 5 rounds");
    expect(h).toContain("7 days without a push");
    expect(h).toContain("no token on file: one line in the thread, nothing runs");
    expect(h).not.toContain("only reviewed again when it is asked for again");
    expect(reviewHelp("X", false, 3, "Bot", undefined, 3)).toContain("I stop after 3 rounds");
  });

  test("with rounds off it says a push is only reviewed when asked for again", () => {
    const h = reviewHelp("X", false, 3, "Bot", undefined, 0);
    expect(h).toContain("*rounds*: off here");
    expect(h).not.toContain("I stop after");
  });

  test("`prompt` prints the real system prompt", () => {
    expect(reviewHelp("X", true, 3, "Bot")).toContain("trace ALL of the diff");
  });
});

describe("red CI in the prompt", () => {
  test("a PR whose change request is already in skips flow B's first step", () => {
    const p = reviewPrompt([PR], "Jarvis", undefined, [], 3, undefined, [PR]);
    expect(p).toContain("change request ALREADY submitted");
    expect(p).toContain("skip (a) and post only the comment");
  });

  test("nothing about it appears when CI was not red", () => {
    expect(reviewPrompt([PR], "Jarvis")).not.toContain("ALREADY submitted");
    expect(reviewPrompt([PR], "Jarvis", undefined, [], 3, undefined, [])).not.toContain("ALREADY submitted");
  });

  test("the help says CI comes first and what the watcher does", () => {
    const help = reviewHelp("//bot", false, 3, "Jarvis");
    expect(help).toContain("CI first");
    expect(help).toContain("watcher");
    expect(help).toContain("never while CI is red");
  });
});
