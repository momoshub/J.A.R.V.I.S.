import { describe, expect, test } from "bun:test";
import {
  STATUS_FINISHED_SHOWN,
  STATUS_RUNNING_SHOWN,
  STATUS_TASKS_MAX,
  STATUS_LABEL,
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

type Task = { type: string; task_id: string; title: string; status: string };
type Plan = { type: string; title: string; tasks: Task[] };
const planOf = (view: { blocks: unknown[] } | undefined): Plan => (view?.blocks[0] ?? {}) as Plan;
const tasksOf = (steps: readonly StatusStep[], thinking?: string): Task[] => planOf(renderStatus(steps, thinking)).tasks;

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
  test("one plan block, a task card per step in order with its status", () => {
    const view = renderStatus([step("a"), step("b", "in_progress"), step("c", "error")]);
    expect(view.blocks).toHaveLength(1);
    const plan = planOf(view);
    expect(plan.type).toBe("plan");
    expect(plan.title).toBe("Burning token… 3 steps");
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
    expect(plan.title).toBe(`Burning token… 12 steps (showing ${STATUS_FINISHED_SHOWN})`);
    expect(plan.tasks).toHaveLength(STATUS_FINISHED_SHOWN);
    expect(plan.tasks.at(-1)?.title).toBe("Step 11");
    expect(JSON.stringify(plan.tasks)).not.toContain("Step 6");
  });

  test("a step in progress is never hidden behind finished ones", () => {
    const steps = [step("slow", "in_progress"), ...Array.from({ length: 10 }, (_, i) => step(String(i)))];
    const plan = planOf(renderStatus(steps));
    expect(plan.tasks.map((t) => t.title)).toContain("Step slow");
    expect(plan.title).toBe(`Burning token… 11 steps (showing ${STATUS_FINISHED_SHOWN + 1})`);
  });

  test("a burst of running steps is capped too, newest kept", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(String(i), "in_progress"));
    const tasks = tasksOf(steps);
    expect(tasks).toHaveLength(STATUS_RUNNING_SHOWN);
    expect(tasks.at(-1)?.title).toBe("Step 19");
  });

  test("one step reads in the singular, and a full list has no 'showing'", () => {
    expect(planOf(renderStatus([step("a")])).title).toBe("Burning token… 1 step");
  });

  test("never more tasks than one plan may carry, however long the titles", () => {
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

  test("the thinking label is one running task, shown only while there is no step", () => {
    expect(tasksOf([], "working on it...").map((t) => [t.title, t.status])).toEqual([["working on it...", "in_progress"]]);
    expect(tasksOf([step("a")], "working on it...").map((t) => t.title)).toEqual(["Step a"]);
    expect(tasksOf([]).map((t) => t.title)).toEqual(["Burning token…"]);
  });
});

describe("what is left when the turn ends", () => {
  test("nothing, when every step worked", () => {
    expect(finalStatus([step("a"), step("b"), step("c")])).toBeUndefined();
    expect(finalStatus([])).toBeUndefined();
  });

  test("a plan titled with the summary and the failures as error cards", () => {
    const view = finalStatus([step("a"), step("b", "error", "Run: gh pr view"), step("c")]);
    expect(view?.text).toBe("🔧 3 steps, 1 failed");
    const plan = planOf(view);
    expect(plan.type).toBe("plan");
    expect(plan.title).toBe("🔧 3 steps, 1 failed");
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
    expect(plan.title).toBe(`🔧 60 steps, 60 failed (…and ${60 - STATUS_TASKS_MAX} more failed)`);
  });
});

// Slack refuses a message with more than one plan block ("Cannot have more than 1 plan block", invalid_blocks).
describe("one plan block per message", () => {
  const steps = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    title: `run: step ${i}`,
    state: i % 3 === 0 ? ("error" as const) : i % 3 === 1 ? ("complete" as const) : ("in_progress" as const),
  }));
  const plans = (blocks: readonly { type: string }[]) => blocks.filter((b) => b.type === "plan").length;
  test("thinking, running and the collapsed view each carry exactly one", () => {
    expect(plans(renderStatus([]).blocks)).toBe(1);
    expect(plans(renderStatus(steps).blocks)).toBe(1);
    expect(plans(finalStatus(steps)?.blocks ?? [])).toBe(1);
  });
  test("the running label is the preset", () => {
    expect(renderStatus([]).text).toBe(`🔧 ${STATUS_LABEL}`);
    expect(renderStatus(steps).text.startsWith(`🔧 ${STATUS_LABEL} 30 steps`)).toBe(true);
  });
});
