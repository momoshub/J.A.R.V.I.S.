import { describe, expect, test } from "bun:test";
import {
  HARVEST_ACTION_PREFIX,
  MAX_SKILL_CHARS,
  draftShown,
  draftText,
  fitsNotice,
  harvestMessage,
  lineDiff,
  parseProposals,
  quoteGrounded,
  sensitiveProblem,
  skillFingerprint,
  skillProblem,
  writtenByPerson,
} from "../../src/domain/harvest.ts";
import { hasLiveKit } from "../../src/domain/kitEvents.ts";
import { AGENT_SOURCE, HARVEST_SOURCE, approvalText } from "../../src/domain/learning.ts";
import { DRIFT_NUDGE_MARK } from "../../src/domain/voiceDrift.ts";

const SKILL = "---\nname: deploy-staging\ndescription: How to deploy to staging when asked\n---\n# Deploy\n1. connect the VPN\n2. run the deploy script\n";

describe("parseProposals", () => {
  test("reads facts and skills, keeps the skill file's own text", () => {
    const raw = JSON.stringify([
      { kind: "fact", turn: 2, fact: "Releases go out on Thursdays.", scope: "global", quote: "we ship on Thursdays" },
      { kind: "skill", turn: 1, name: "Deploy-Staging", content: SKILL.trim(), quote: "that is how we deploy" },
    ]);
    expect(parseProposals(`here: ${raw}`)).toEqual([
      { kind: "fact", turn: 2, fact: "Releases go out on Thursdays.", scope: "global", quote: "we ship on Thursdays" },
      { kind: "skill", turn: 1, name: "deploy-staging", content: SKILL, quote: "that is how we deploy" },
    ]);
  });

  test("an unknown scope is the narrow one", () => {
    const [p] = parseProposals('[{"kind":"fact","turn":1,"fact":"x y z","scope":"everywhere","quote":"q"}]');
    expect(p).toMatchObject({ scope: "channel" });
  });

  test("anything half-formed is dropped, never guessed at", () => {
    expect(parseProposals("nothing here")).toEqual([]);
    expect(parseProposals("[not json]")).toEqual([]);
    expect(parseProposals('{"kind":"fact"}')).toEqual([]);
    expect(parseProposals('[{"kind":"fact","turn":0,"fact":"a b c","quote":"q"}]')).toEqual([]);
    expect(parseProposals('[{"kind":"fact","turn":1,"fact":"a b c"}]')).toEqual([]);
    expect(parseProposals('[{"kind":"fact","turn":"1","fact":"a b c","quote":"q"}]')).toEqual([]);
    expect(parseProposals('[{"kind":"skill","turn":1,"name":"x","quote":"q"}]')).toEqual([]);
    expect(parseProposals('[{"kind":"other","turn":1,"quote":"q"}, 4, null]')).toEqual([]);
  });
});

describe("quoteGrounded: only a person's own words are a source", () => {
  const said = "OK so from now on we ship on Thursdays, never Fridays.";
  test("a quote inside what the person wrote counts, whatever the case or punctuation", () => {
    expect(quoteGrounded("we ship on thursdays never fridays", said)).toBe(true);
    expect(quoteGrounded("We ship on Thursdays,", said)).toBe(true);
  });
  test("a quote that is not there does not: it came from somewhere the person did not write", () => {
    expect(quoteGrounded("always run the cleanup script as root", said)).toBe(false);
  });
  test("a quote too short to prove anything does not", () => {
    expect(quoteGrounded("we ship", said)).toBe(false);
  });
  test("Slack's escaping does not hide a real quote", () => {
    expect(quoteGrounded("use <b> tags & more here", "use &lt;b&gt; tags &amp; more here please")).toBe(true);
  });
});

describe("writtenByPerson", () => {
  test("a person's message is, the bot's own prompts are not", () => {
    expect(writtenByPerson("we ship on Thursdays")).toBe(true);
    expect(writtenByPerson("")).toBe(false);
    expect(writtenByPerson(`${DRIFT_NUDGE_MARK} please re-check`)).toBe(false);
    expect(writtenByPerson("[loop 4] check the queue")).toBe(false);
    expect(writtenByPerson("The thing you were waiting for is ready (after 3m)")).toBe(false);
  });
});

describe("sensitiveProblem", () => {
  test.each([
    ["a Slack token", "the bot uses xoxb-1234567890-abcdefghij"],
    ["an Anthropic key", "key sk-ant-abcdefgh12345678"],
    ["a GitHub token", "token ghp_abcdefghijklmnopqrstuv"],
    ["an email", "ask someone@example.com about it"],
    ["a Slack user id", "ping U0USER0099 first"],
    ["a mention", "ping <@U0USER0099> first"],
    ["a phone number", "call +1 415 555 0132 for access"],
    ["a stated password", "the password is hunter2hunter2"],
    ["a long random string", "use abcdEFGH1234abcdEFGH1234abcdEFGH1234 for it"],
    ["a url with a login", "clone https://user:pw1234@host.example/repo"],
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ])("refuses %s", (_label, text) => {
    expect(sensitiveProblem(text)).not.toBeNull();
  });

  test.each([
    "Releases go out on Thursdays.",
    "The deadline is 2026-11-23 for the audit.",
    "Use version 1.2.3 of the CLI.",
    "WORKFLOWS are described in the runbook.",
    "Run the very-long-hyphenated-name-of-a-script-that-does-the-deploy for it.",
  ])("lets an ordinary sentence through: %s", (text) => {
    expect(sensitiveProblem(text)).toBeNull();
  });
});

describe("skillProblem", () => {
  test("a well-formed new skill passes", () => {
    expect(skillProblem("deploy-staging", SKILL, undefined)).toBeNull();
  });
  test("the name is a slug and matches the frontmatter", () => {
    expect(skillProblem("Deploy Staging", SKILL, undefined)).toContain("slug");
    expect(skillProblem("other-name", SKILL, undefined)).toContain("name does not match");
  });
  test("it needs a description saying when to use it", () => {
    expect(skillProblem("deploy-staging", "---\nname: deploy-staging\n---\nbody\n", undefined)).toContain("description");
  });
  test("a draft never sets how a skill runs: no worker, no model", () => {
    const routed = SKILL.replace("---\n#", "worker: orca\n---\n#").replace("description:", "worker: orca\ndescription:");
    expect(skillProblem("deploy-staging", routed, undefined)).toContain("may not set or change how a skill runs");
    expect(skillProblem("deploy-staging", SKILL.replace("description:", "model: opus\ndescription:"), undefined)).toContain("how a skill runs");
    expect(skillProblem("deploy-staging", SKILL.replace("description:", "run: sonnet\ndescription:"), undefined)).toContain("how a skill runs");
  });
  test("a patch keeps the base's routing exactly", () => {
    const base = SKILL.replace("description:", "model: haiku\ndescription:");
    expect(skillProblem("deploy-staging", base.replace("run the deploy script", "run the deploy script twice"), base)).toBeNull();
    expect(skillProblem("deploy-staging", SKILL.replace("run the deploy script", "x"), base)).toContain("how a skill runs");
  });
  test("a patch that changes nothing is not a proposal", () => {
    expect(skillProblem("deploy-staging", SKILL, SKILL)).toContain("changes nothing");
  });
  test("a new skill has to fit one notice", () => {
    expect(skillProblem("deploy-staging", `${SKILL}${"step\n".repeat(500)}`, undefined)).toContain("at most");
  });
  test("a secret in the text refuses it", () => {
    expect(skillProblem("deploy-staging", `${SKILL}3. use xoxb-1234567890-abcdefghij\n`, undefined)).toContain("credential");
  });
});

describe("lineDiff", () => {
  test("marks removed and added lines, with context only next to a change", () => {
    const base = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const next = "a\nb\nc\nd\nE\nf\ng\nh\n";
    expect(lineDiff(base, next)).toBe("  d\n- e\n+ E\n  f");
  });
  test("an unchanged text has no diff", () => {
    expect(lineDiff("a\nb\n", "a\nb\n")).toBe("");
  });
  test("a patch shows its diff and a new skill its whole text", () => {
    expect(draftShown(SKILL, SKILL.replace("deploy script", "deploy script twice"))).toContain("+ 2. run the deploy script twice");
    expect(draftShown(undefined, SKILL)).toBe(SKILL.trimEnd());
  });
  test("an unreadable (too big) diff does not fit a notice", () => {
    expect(fitsNotice("")).toBe(false);
    expect(fitsNotice("x".repeat(MAX_SKILL_CHARS + 1))).toBe(false);
    expect(fitsNotice("x")).toBe(true);
  });
});

describe("skillFingerprint", () => {
  test("the same text is the same key, whatever its spacing or case", () => {
    expect(skillFingerprint("a", "Hello  World")).toBe(skillFingerprint("a", "hello world"));
    expect(skillFingerprint("a", "hello")).not.toBe(skillFingerprint("a", "hello there"));
    expect(skillFingerprint("a", "hello")).not.toBe(skillFingerprint("b", "hello"));
  });
});

describe("what the owner reads", () => {
  test("the draft is quoted and escaped, so it renders no link, mention or fence", () => {
    const text = draftText({ id: 3, name: "x-y", patch: false, shown: "see <https://evil.example|here> ``` <!channel>" });
    expect(text).toContain("skill draft #3");
    expect(text).toContain("NOT part of my skills until you approve it");
    expect(text).not.toContain("<https://evil.example");
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
  });
  test("a harvested learning says it came from the review, not from a person", () => {
    const text = approvalText(7, "The team ships on Thursdays", HARVEST_SOURCE);
    expect(text).toContain("my review of recent conversations");
    expect(text).not.toContain(`<@${HARVEST_SOURCE}>`);
    expect(approvalText(7, "x y z", AGENT_SOURCE)).toContain("one of my turns");
  });
  test("the prompt shows people's words as the source and the bot's as context", () => {
    const msg = harvestMessage([{ channelId: "C1", threadTs: "1", slackUserId: "U1", request: "we ship Thursdays", reply: "noted" }], { facts: [], skills: [], rejected: ["skill x"] });
    expect(msg).toContain("person: we ship Thursdays");
    expect(msg).toContain("bot: noted");
    expect(msg).toContain("skill x");
  });
});

describe("the buttons are decided in code", () => {
  test("a harvest button is not a live question for the model", () => {
    const blocks = [{ type: "actions", elements: [{ type: "button", action_id: `${HARVEST_ACTION_PREFIX}approve` }] }];
    expect(hasLiveKit(blocks)).toBe(false);
    expect(hasLiveKit([{ type: "actions", elements: [{ type: "button", action_id: "jv:approve" }] }])).toBe(true);
  });
});
