import { describe, expect, test } from "bun:test";
import {
  STATUS_FINISHED_SHOWN,
  STATUS_LABEL,
  STATUS_RUNNING_SHOWN,
  STATUS_TASKS_MAX,
  STATUS_TITLE_CHARS,
  finalStatus,
  renderStatus,
  taskTitle,
  type StatusStep,
} from "../../src/domain/statusSteps.ts";
import { MAX_BLOCKS } from "../../src/domain/blockKit.ts";

const step = (id: string, state: StatusStep["state"] = "complete", title = `Step ${id}`, logLine?: string): StatusStep => ({
  id,
  title,
  state,
  ...(logLine ? { logLine } : {}),
});

type Task = { type: string; task_id: string; title: string; status: string };
type Plan = { type: string; title: string; tasks: Task[] };
type Header = { type: string; elements: { type: string; text: string }[] };
const plansOf = (view: { blocks: unknown[] } | undefined): Plan[] => (view?.blocks ?? []).filter((b) => (b as Plan).type === "plan") as Plan[];
const headerOf = (view: { blocks: unknown[] } | undefined): string => ((view?.blocks[0] ?? {}) as Header).elements?.[0]?.text ?? "";
const tasksOf = (steps: readonly StatusStep[], thinking?: string): Task[] => plansOf(renderStatus(steps, thinking)).flatMap((p) => p.tasks);

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
  test("a header line, then one plan per step in order, each with one task card carrying its status", () => {
    const view = renderStatus([step("a"), step("b", "in_progress"), step("c", "error")]);
    expect(view.blocks).toHaveLength(4);
    expect((view.blocks[0] as Header).type).toBe("context");
    expect(headerOf(view)).toBe(`${STATUS_LABEL} 3 steps`);
    const plans = plansOf(view);
    expect(plans.map((p) => p.title)).toEqual(["Step a", "Step b", "Step c"]);
    expect(plans.every((p) => p.tasks.length === 1)).toBe(true);
    expect(plans.flatMap((p) => p.tasks).map((t) => [t.type, t.task_id, t.title, t.status])).toEqual([
      ["task_card", "a", "Step a", "complete"],
      ["task_card", "b", "Step b", "in_progress"],
      ["task_card", "c", "Step c", "error"],
    ]);
    expect(view.text).toBe(`🔧 ${STATUS_LABEL} 3 steps`);
    expect(STATUS_LABEL).toBe("Burning token…");
  });

  test("shows the last few finished steps and counts the rest in the header", () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(String(i)));
    const view = renderStatus(steps);
    expect(headerOf(view)).toBe(`${STATUS_LABEL} 12 steps (showing ${STATUS_FINISHED_SHOWN})`);
    expect(plansOf(view)).toHaveLength(STATUS_FINISHED_SHOWN);
    expect(plansOf(view).at(-1)?.title).toBe("Step 11");
    expect(JSON.stringify(view.blocks)).not.toContain("Step 6");
  });

  test("a step in progress is never hidden behind finished ones", () => {
    const steps = [step("slow", "in_progress"), ...Array.from({ length: 10 }, (_, i) => step(String(i)))];
    const view = renderStatus(steps);
    expect(plansOf(view).map((p) => p.title)).toContain("Step slow");
    expect(headerOf(view)).toBe(`${STATUS_LABEL} 11 steps (showing ${STATUS_FINISHED_SHOWN + 1})`);
  });

  test("a burst of running steps is capped too, newest kept", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(String(i), "in_progress"));
    const tasks = tasksOf(steps);
    expect(tasks).toHaveLength(STATUS_RUNNING_SHOWN);
    expect(tasks.at(-1)?.title).toBe("Step 19");
  });

  test("one step reads in the singular, and a full list has no 'showing'", () => {
    expect(headerOf(renderStatus([step("a")]))).toBe(`${STATUS_LABEL} 1 step`);
  });

  test("never more blocks than Slack allows, however many steps and long the titles", () => {
    const steps = Array.from({ length: 60 }, (_, i) => step(String(i), i % 2 ? "complete" : "in_progress", "y".repeat(500)));
    const view = renderStatus(steps);
    expect(plansOf(view).length).toBeLessThanOrEqual(STATUS_TASKS_MAX);
    expect(view.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(tasksOf(steps).every((t) => t.title.length <= STATUS_TITLE_CHARS)).toBe(true);
  });

  test("task ids are sanitised to what Slack allows and stay unique", () => {
    const tasks = tasksOf([step("tool use/1:a", "complete"), step("tool_use_1_a", "complete"), step("", "in_progress")]);
    expect(tasks.map((t) => t.task_id)).toEqual(["tool_use_1_a", "tool_use_1_a_2", "step_2"]);
    expect(tasks.every((t) => /^[A-Za-z0-9_-]+$/.test(t.task_id))).toBe(true);
  });

  test("the thinking label is one plan with one running task, shown only while there is no step", () => {
    const view = renderStatus([], "working on it...");
    expect(view.blocks).toHaveLength(1);
    expect(plansOf(view).map((p) => p.title)).toEqual([STATUS_LABEL]);
    expect(tasksOf([], "working on it...").map((t) => [t.title, t.status])).toEqual([["working on it...", "in_progress"]]);
    expect(tasksOf([step("a")], "working on it...").map((t) => t.title)).toEqual(["Step a"]);
    expect(tasksOf([]).map((t) => t.title)).toEqual([STATUS_LABEL]);
    expect(renderStatus([]).text).toBe(`🔧 ${STATUS_LABEL}`);
  });
});

describe("what is left when the turn ends", () => {
  test("nothing, when every step worked", () => {
    expect(finalStatus([step("a"), step("b"), step("c")])).toBeUndefined();
    expect(finalStatus([])).toBeUndefined();
  });

  test("a header with the summary and one error plan per failure", () => {
    const view = finalStatus([step("a"), step("b", "error", "Run: gh pr view"), step("c"), step("d", "error", "Run: gh pr diff")]);
    expect(view?.text).toBe("🔧 4 steps, 2 failed");
    expect(headerOf(view)).toBe("🔧 4 steps, 2 failed");
    expect(plansOf(view).map((p) => p.title)).toEqual(["Run: gh pr view", "Run: gh pr diff"]);
    expect(plansOf(view).flatMap((p) => p.tasks).map((t) => [t.task_id, t.status])).toEqual([
      ["b", "error"],
      ["d", "error"],
    ]);
  });

  test("a lone failed step is kept, unlike a lone clean one", () => {
    expect(finalStatus([step("a", "error", "Run: gh pr view")])?.text).toBe("🔧 1 steps, 1 failed");
  });

  test("a step still marked running when the turn ended is not a failure", () => {
    expect(finalStatus([step("a"), step("b", "in_progress")])).toBeUndefined();
  });

  test("many failures are capped and the rest counted in the header", () => {
    const steps = Array.from({ length: 60 }, (_, i) => step(String(i), "error", `Run: ${"&".repeat(300)}`));
    const view = finalStatus(steps);
    expect(plansOf(view)).toHaveLength(STATUS_TASKS_MAX);
    expect(view?.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(plansOf(view).flatMap((p) => p.tasks).every((t) => t.status === "error" && t.title.length <= STATUS_TITLE_CHARS)).toBe(true);
    expect(headerOf(view)).toBe(`🔧 60 steps, 60 failed (…and ${60 - STATUS_TASKS_MAX} more failed)`);
  });
});
