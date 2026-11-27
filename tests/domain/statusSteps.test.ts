import { describe, expect, test } from "bun:test";
import {
  STATUS_COMMAND_CHARS,
  STATUS_DETAIL_CHARS,
  STATUS_FINISHED_SHOWN,
  STATUS_OUTPUT_CHARS,
  STATUS_LABEL,
  STATUS_RUNNING_SHOWN,
  STATUS_TASKS_MAX,
  STATUS_TITLE_CHARS,
  finalStatus,
  renderStatus,
  taskTitle,
  type StatusStep,
} from "../../src/domain/statusSteps.ts";

const step = (id: string, state: StatusStep["state"] = "complete", title = `Step ${id}`, logLine?: string): StatusStep => ({
  id,
  title,
  state,
  ...(logLine ? { logLine } : {}),
});

type Rich = { type: string; elements: { type: string; elements: { type: string; text: string; style?: { code?: boolean } }[] }[] };
type Task = {
  type: string;
  task_id: string;
  title: string;
  status: string;
  details?: Rich;
  output?: Rich;
  sources?: { type: string; url: string; text: string }[];
};
type Plan = { type: string; title: string; count: string; header?: Task; tasks: Task[] };
/** The header card and the task cards after it, read back as one titled list. */
const planOf = (view: { blocks: unknown[] } | undefined): Plan => {
  const [head, ...more] = (view?.blocks ?? []) as (Task & { elements?: { text: string }[] })[];
  const last = more.at(-1);
  const line = last?.type === "context" ? more.pop() : undefined;
  const rest = more;
  return {
    type: head?.type === "task_card" && head.task_id === "status_header" && rest.every((b) => b.type === "task_card") ? "cards" : "?",
    title: head?.title ?? "",
    count: line?.elements?.[0]?.text ?? "",
    header: head,
    tasks: rest,
  };
};
const tasksOf = (steps: readonly StatusStep[], thinking?: string): Task[] => planOf(renderStatus(steps, thinking)).tasks;
const textOf = (r: Rich | undefined): string => (r?.elements ?? []).flatMap((e) => e.elements.map((x) => x.text)).join("");

describe("a task card title", () => {
  test("is the step title, plus the log line when there is one", () => {
    expect(taskTitle(step("a", "in_progress", "Run: 🏃 Listing files", "17"))).toBe("Run: 🏃 Listing files · log line 17");
    expect(taskTitle(step("a"))).toBe("Step a");
  });

  test("a long title is clipped but a grouped one keeps its run count", () => {
    const title = taskTitle(step("a", "complete", `${"x".repeat(400)} (7 runs)`, "3"));
    expect(title.length).toBeLessThanOrEqual(STATUS_TITLE_CHARS);
    expect(title).toContain(" (7 runs) · log line 3");
  });

  test("is plain text: nothing is escaped", () => {
    expect(taskTitle(step("a", "complete", "Run: a && b <c>"))).toBe("Run: a && b <c>");
  });
});

describe("the running message", () => {
  test("a header line, then a task card per step in order with its status", () => {
    const view = renderStatus([step("a"), step("b", "in_progress"), step("c", "error")]);
    expect(view.blocks).toHaveLength(5);
    const plan = planOf(view);
    expect(plan.header?.status).toBe("in_progress");
    expect(plan.type).toBe("cards");
    expect(plan.title).toBe("Burning token…");
    expect(plan.count).toBe("3 steps");
    expect(plan.tasks.map((t) => [t.type, t.task_id, t.title, t.status])).toEqual([
      ["task_card", "a", "Step a", "complete"],
      ["task_card", "b", "Step b", "in_progress"],
      ["task_card", "c", "Step c", "error"],
    ]);
    expect(view.text).toBe("🔧 Burning token… 3 steps");
  });

  test("shows the last few finished steps and counts the rest in the title", () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(String(i)));
    const plan = planOf(renderStatus(steps));
    expect(plan.count).toBe(`12 steps, showing ${STATUS_FINISHED_SHOWN}`);
    expect(plan.tasks).toHaveLength(STATUS_FINISHED_SHOWN);
    expect(plan.tasks.at(-1)?.title).toBe("Step 11");
    expect(JSON.stringify(plan.tasks)).not.toContain("Step 6");
  });

  test("a step in progress is never hidden behind finished ones", () => {
    const steps = [step("slow", "in_progress"), ...Array.from({ length: 10 }, (_, i) => step(String(i)))];
    const plan = planOf(renderStatus(steps));
    expect(plan.tasks.map((t) => t.title)).toContain("Step slow");
    expect(plan.count).toBe(`11 steps, showing ${STATUS_FINISHED_SHOWN + 1}`);
  });

  test("a burst of running steps is capped too, newest kept", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(String(i), "in_progress"));
    const tasks = tasksOf(steps);
    expect(tasks).toHaveLength(STATUS_RUNNING_SHOWN);
    expect(tasks.at(-1)?.title).toBe("Step 19");
  });

  test("one step reads in the singular, and a full list has no 'showing'", () => {
    expect(planOf(renderStatus([step("a")])).count).toBe("1 step");
  });

  test("never more task cards than the cap, however long the titles", () => {
    const steps = Array.from({ length: 60 }, (_, i) => step(String(i), i % 2 ? "complete" : "in_progress", "y".repeat(500)));
    const tasks = tasksOf(steps);
    expect(tasks.length).toBeLessThanOrEqual(STATUS_TASKS_MAX);
    expect(tasks.every((t) => t.title.length <= STATUS_TITLE_CHARS)).toBe(true);
  });

  test("task ids are sanitised to what Slack allows and stay unique", () => {
    const tasks = tasksOf([step("tool use/1:a", "complete"), step("tool_use_1_a", "complete"), step("", "in_progress")]);
    expect(tasks.map((t) => t.task_id)).toEqual(["tool_use_1_a", "tool_use_1_a_2", "step_2"]);
    expect(tasks.every((t) => /^[A-Za-z0-9_-]+$/.test(t.task_id))).toBe(true);
  });

  test("the thinking label is one running task after the header, shown only while there is no step", () => {
    expect(tasksOf([], "working on it...").map((t) => [t.title, t.status])).toEqual([["working on it...", "in_progress"]]);
    expect(tasksOf([step("a")], "working on it...").map((t) => t.title)).toEqual(["Step a"]);
    // nothing to add to the header: it is the only card
    expect(tasksOf([])).toEqual([]);
    expect(planOf(renderStatus([])).title).toBe(STATUS_LABEL);
  });
});

describe("what is left when the turn ends", () => {
  test("nothing, when every step worked", () => {
    expect(finalStatus([step("a"), step("b"), step("c")])).toBeUndefined();
    expect(finalStatus([])).toBeUndefined();
  });

  test("the header card carries the summary and the error cards follow", () => {
    const view = finalStatus([step("a"), step("b", "error", "Run: gh pr view"), step("c")]);
    expect(view?.text).toBe("🔧 3 steps, 1 failed");
    const plan = planOf(view);
    expect(plan.type).toBe("cards");
    expect(plan.header?.status).toBe("error");
    expect(plan.count).toBe("🔧 3 steps, 1 failed");
    expect(plan.tasks.map((t) => [t.task_id, t.title, t.status])).toEqual([["b", "Run: gh pr view", "error"]]);
  });

  test("a lone failed step is kept, unlike a lone clean one", () => {
    expect(finalStatus([step("a", "error", "Run: gh pr view")])?.text).toBe("🔧 1 steps, 1 failed");
  });

  test("a step still marked running when the turn ended is not a failure", () => {
    expect(finalStatus([step("a"), step("b", "in_progress")])).toBeUndefined();
  });

  test("many failures are capped and the rest counted in the title", () => {
    const steps = Array.from({ length: 60 }, (_, i) => step(String(i), "error", `Run: ${"&".repeat(300)}`));
    const plan = planOf(finalStatus(steps));
    expect(plan.tasks).toHaveLength(STATUS_TASKS_MAX);
    expect(plan.tasks.every((t) => t.status === "error" && t.title.length <= STATUS_TITLE_CHARS)).toBe(true);
    expect(plan.count).toBe(`🔧 60 steps, 60 failed (…and ${60 - STATUS_TASKS_MAX} more failed)`);
  });
});

// Slack folds a plan block (hiding the tool names) and refuses more than one per message ("Cannot have more than 1 plan block").
describe("no plan block at all", () => {
  const steps = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    title: `run: step ${i}`,
    state: i % 3 === 0 ? ("error" as const) : i % 3 === 1 ? ("complete" as const) : ("in_progress" as const),
  }));
  const plans = (blocks: readonly { type: string }[]) => blocks.filter((b) => b.type === "plan").length;
  test("thinking, running and the collapsed view carry none, and stay under Slack's 50 blocks", () => {
    for (const v of [renderStatus([]), renderStatus(steps), finalStatus(steps)]) {
      expect(plans(v?.blocks ?? [])).toBe(0);
      expect((v?.blocks ?? []).length).toBeLessThanOrEqual(STATUS_TASKS_MAX + 2);
      // the only context block is the count line, last; the thinking-only message has none
      expect((v?.blocks ?? []).filter((b) => b.type === "context").length).toBeLessThanOrEqual(1);
      expect((v?.blocks ?? []).slice(0, -1).some((b) => b.type === "context")).toBe(false);
    }
  });
  test("the running label is the preset", () => {
    expect(renderStatus([]).text).toBe(`🔧 ${STATUS_LABEL}`);
    expect(renderStatus(steps).text.startsWith(`🔧 ${STATUS_LABEL} 30 steps`)).toBe(true);
  });
});

describe("the header is the first task card", () => {
  test("title only: no details, output or sources, so nothing expands; in_progress while running", () => {
    const [head] = renderStatus([step("a", "in_progress")]).blocks as Task[];
    expect(head).toEqual({ type: "task_card", task_id: "status_header", title: "Burning token…", status: "in_progress" });
  });
  test("its title is the dashboard thinking label, STATUS_LABEL only when that is empty", () => {
    expect(planOf(renderStatus([step("a")], undefined, "Cooking…")).title).toBe("Cooking…");
    expect(planOf(renderStatus([step("a")], undefined, "  ")).title).toBe(STATUS_LABEL);
    expect(planOf(renderStatus([], undefined, "Cooking…")).title).toBe("Cooking…");
    expect(planOf(finalStatus([step("a", "error")], "Cooking…")).title).toBe("Cooking…");
    expect(planOf(finalStatus([step("a", "error")])).title).toBe(STATUS_LABEL);
  });
  test("the placeholder equal to the header is not a second card, a different one is", () => {
    expect(tasksOf([], "Cooking…")).toHaveLength(1);
    expect(planOf(renderStatus([], "Cooking…", "Cooking…")).tasks).toEqual([]);
  });
  test("the count is the LAST block, a context line, never in the header", () => {
    const steps = [step("status_header", "in_progress"), ...Array.from({ length: 9 }, (_, i) => step(String(i)))];
    const blocks = renderStatus(steps).blocks;
    expect(blocks.at(-1)).toMatchObject({ type: "context", elements: [{ type: "plain_text", text: `10 steps, showing ${STATUS_FINISHED_SHOWN + 1}` }] });
    const plan = planOf({ blocks });
    expect(plan.title).toBe(STATUS_LABEL);
    const ids = [plan.header?.task_id, ...plan.tasks.map((t) => t.task_id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("the final message: header card, error cards, then the summary line; header has no details", () => {
    const view = finalStatus([step("a"), step("b", "error")]);
    const plan = planOf(view);
    expect(plan.type).toBe("cards");
    expect(plan.header).not.toHaveProperty("details");
    expect(plan.count).toBe("🔧 2 steps, 1 failed");
    expect(view?.blocks.at(-1)?.type).toBe("context");
  });
});

describe("card content", () => {
  const rich = (): StatusStep => ({
    id: "r",
    title: "Run: 🏃 Read the linked Acme thread",
    state: "complete",
    logLine: "650",
    detail: "Read the linked Acme thread",
    command: "cd xyz && cat file.a",
    output: "line one\nline two\nline three",
  });

  test("details: the description, then the command as code", () => {
    const [t] = tasksOf([rich()]);
    expect(t?.details?.type).toBe("rich_text");
    const els = t?.details?.elements[0]?.elements ?? [];
    expect(els.map((e) => e.text)).toEqual(["Read the linked Acme thread", "\n", "cd xyz && cat file.a"]);
    expect(els[2]?.style).toEqual({ code: true });
    expect(els[0]?.style).toBeUndefined();
  });

  test("output: a short result (two lines at most) and the log line", () => {
    const [t] = tasksOf([rich()]);
    expect(textOf(t?.output)).toBe("line one ⏎ line two\nlog line 650");
  });

  test("a step with nothing to say has neither details nor output nor sources", () => {
    const [t] = tasksOf([step("a")]);
    expect(t).not.toHaveProperty("details");
    expect(t).not.toHaveProperty("output");
    expect(t).not.toHaveProperty("sources");
  });

  test("only the log line when the step has no result yet", () => {
    const [t] = tasksOf([{ ...step("a", "in_progress", "Run: x", "9"), command: "ls" }]);
    expect(textOf(t?.output)).toBe("log line 9");
  });

  test("every text field is clipped", () => {
    const [t] = tasksOf([{ ...rich(), detail: "d".repeat(2000), command: "c".repeat(5000), output: "o".repeat(5000) }]);
    const [d, , c] = t?.details?.elements[0]?.elements ?? [];
    expect(d?.text.length).toBeLessThanOrEqual(STATUS_DETAIL_CHARS);
    expect(c?.text.length).toBeLessThanOrEqual(STATUS_COMMAND_CHARS);
    expect(textOf(t?.output).split("\n")[0]?.length).toBeLessThanOrEqual(STATUS_OUTPUT_CHARS);
  });

  test("nothing is escaped: rich_text is not mrkdwn", () => {
    const [t] = tasksOf([{ ...rich(), command: "a && b <c> *d*", output: "<x> & *y*" }]);
    expect(textOf(t?.details)).toContain("a && b <c> *d*");
    expect(textOf(t?.output)).toContain("<x> & *y*");
  });

  test("secrets and env values are redacted in details and output", () => {
    // built at run time: the shapes must not sit in the repo as literals (the secret scan flags them)
    const slack = ["xox", "b-1234567890-abcdefghij"].join("");
    const gh = ["gh", "p_abcdefghijklmnop1234"].join("");
    const bearer = ["abcdefghijklmnop", "qrstuvwxyz"].join("");
    const aws = ["AKI", "AABCDEFGHIJKLMNOP"].join("");
    const [t] = tasksOf([
      {
        ...rich(),
        detail: `use ${slack}`,
        command: `GH_TOKEN=${gh} curl -H "Authorization: Bearer ${bearer}" https://x.test/a && JARVIS_RUN_TICKET_FILE=/p/t cmd`,
        output: `denied ${slack} API_KEY="s3cr3t value" ${aws}`,
      },
    ]);
    const all = JSON.stringify(t);
    for (const leak of [slack, gh, bearer, "s3cr3t", aws, "/p/t"]) expect(all).not.toContain(leak);
    expect(all).toContain("[redacted]");
  });

  // values built at run time: secret shapes must not sit in the repo as literals (the secret scan flags them)
  const j = (...p: string[]): string => p.join("");
  const leaks = (command: string, output: string, ...bad: string[]): void => {
    const [t] = tasksOf([{ ...rich(), command, output, detail: "d" }]);
    const all = JSON.stringify(t);
    for (const b of bad) expect(all).not.toContain(b);
  };

  test("wider scrub: keys in any case, JSON keys, flags, URL userinfo, query tokens", () => {
    const pw = j("hunter", "2pass");
    const tok = j("ya29.", "A0ARrdaM-abcdef");
    leaks(`curl -u kai:${j("S3cret", "Pass")} https://user:${pw}@api.example.com/x?access_token=${tok}`, `{"access_token":"${tok}"}`, pw, tok, j("S3cret", "Pass"));
    leaks(`TOKEN=${j("abc", "123secret")} gh api /user --password=${pw}`, `password: ${pw}`, j("abc", "123secret"), pw);
    leaks("cat config", `DATABASE_URL=postgres://admin:${pw}@db.internal/app`, pw);
  });

  test("wider scrub: JWTs, fine-grained PATs, live keys, PEM keys, webhooks", () => {
    const jwt = j("eyJ", "hbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "abc123def");
    const pat = j("github", "_pat_11ABCDEFG0abcdefghijklmn_opqrstuvwxyz0123");
    const live = j("rk", "_live_51Habcdefghijkl");
    const pem = j("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----");
    const hook = j("https://hooks.slack", ".com/services/T000/B000/", "XXXXXXXXXXXX");
    leaks(`curl ${hook}`, `${jwt} ${pat} ${live} ${pem}`, jwt, pat, live, "MIIBOgIBAAJBAK", "XXXXXXXXXXXX");
  });

  test("the output of a step that fetches a secret is not shown at all, the log line still is", () => {
    const val = j("rk", "_live_51Hsecretvalue1");
    for (const command of ["op read op://Private/stripe/credential", "security find-generic-password -s x -w", "printenv STRIPE", "cat .env", "cat ~/.ssh/id_rsa", "cd x && env"]) {
      const [t] = tasksOf([{ ...rich(), command, output: val }]);
      expect(JSON.stringify(t)).not.toContain("secretvalue1");
      expect(textOf(t?.output)).toBe("log line 650");
    }
    // an ordinary command keeps its output
    expect(textOf(tasksOf([{ ...rich(), command: "ls", output: "a.ts" }])[0]?.output)).toBe("a.ts\nlog line 650");
  });

  test("sources: no userinfo, no query or fragment, no webhook, capped length", () => {
    const [t] = tasksOf([
      {
        ...rich(),
        detail: `see https://user:pw@x.test/a and https://ok.test/p/1?access_token=zzzzzzzzzz#frag ${j("https://hooks.slack", ".com/services/T0/B0/XXXX")} https://long.test/${"a".repeat(400)}`,
        command: "true",
      },
    ]);
    expect(t?.sources).toEqual([{ type: "url", url: "https://ok.test/p/1", text: "https://ok.test/p/1" }]);
  });

  test("sources: urls from the command or description, deduped, max three, type url", () => {
    const [t] = tasksOf([
      {
        ...rich(),
        detail: "Read https://github.com/o/r/pull/1.",
        command: "gh pr view https://github.com/o/r/pull/1 && curl https://a.test/x https://b.test/y https://c.test/z",
      },
    ]);
    expect(t?.sources?.map((s) => [s.type, s.url])).toEqual([
      ["url", "https://github.com/o/r/pull/1"],
      ["url", "https://a.test/x"],
      ["url", "https://b.test/y"],
    ]);
    expect(t?.sources?.every((s) => s.text.length > 0)).toBe(true);
  });

  test("an explicit source keeps its text", () => {
    const [t] = tasksOf([{ ...step("a"), sources: [{ url: "https://x.test/p", text: "PR 5" }] }]);
    expect(t?.sources).toEqual([{ type: "url", url: "https://x.test/p", text: "PR 5" }]);
  });

  test("error cards in the final message carry details and output", () => {
    const failed: StatusStep = { ...rich(), state: "error", output: "Error: ENOENT file.a" };
    const plan = planOf(finalStatus([step("ok"), failed]));
    const t = plan.tasks[0];
    expect(textOf(t?.details)).toContain("cd xyz && cat file.a");
    expect(textOf(t?.output)).toBe("Error: ENOENT file.a\nlog line 650");
  });

  test("a full message stays under 50 blocks and 40k characters, with at most one plan: never", () => {
    const fat = Array.from({ length: 60 }, (_, i) => ({
      ...rich(),
      id: `s${i}`,
      state: i % 2 ? ("error" as const) : ("in_progress" as const),
      title: "t".repeat(500),
      detail: "d".repeat(3000),
      command: "c".repeat(3000),
      output: "o".repeat(3000),
    }));
    for (const v of [renderStatus(fat), finalStatus(fat)]) {
      expect(v?.blocks.length).toBeLessThanOrEqual(STATUS_TASKS_MAX + 2);
      expect(JSON.stringify(v?.blocks).length).toBeLessThan(40_000);
      expect(v?.blocks.some((b) => b.type === "plan")).toBe(false);
    }
  });
});
