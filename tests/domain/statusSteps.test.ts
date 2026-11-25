import { describe, expect, test } from "bun:test";
import {
  STATUS_FINISHED_SHOWN,
  STATUS_RUNNING_SHOWN,
  STATUS_TEXT_BUDGET,
  escapeMrkdwn,
  finalStatus,
  renderStatus,
  stepLine,
  type StatusStep,
} from "../../src/domain/statusSteps.ts";

const step = (id: string, state: StatusStep["state"] = "complete", title = `Step ${id}`, logLine?: string): StatusStep => ({
  id,
  title,
  state,
  ...(logLine ? { logLine } : {}),
});
const linesOf = (steps: readonly StatusStep[], thinking?: string): string[] => {
  const block = renderStatus(steps, thinking).blocks[0] as unknown as { elements: { text: string }[] };
  return (block.elements[0]?.text ?? "").split("\n");
};

describe("a step line", () => {
  test("carries its state icon, title and log line", () => {
    expect(stepLine(step("a", "in_progress", "Run: 🏃 Listing files", "17"))).toBe("⏳ Run: 🏃 Listing files · log line 17");
    expect(stepLine(step("a", "complete"))).toBe("✅ Step a");
    expect(stepLine(step("a", "error"))).toBe("❌ Step a");
  });

  test("a long title is clipped but a grouped one keeps its run count", () => {
    const line = stepLine(step("a", "complete", `${"x".repeat(400)} (7 runs)`, "3"));
    expect(line.length).toBeLessThan(260);
    expect(line).toContain(" (7 runs) · log line 3");
  });

  test("mrkdwn control characters cannot ping or link", () => {
    expect(escapeMrkdwn("<!channel> a & b <https://x|y>")).toBe("&lt;!channel&gt; a &amp; b &lt;https://x|y&gt;");
    expect(stepLine(step("a", "complete", "Run: <!here>"))).not.toContain("<!here>");
  });
});

describe("the running message", () => {
  test("one line per step, in order, as one context block", () => {
    const view = renderStatus([step("a"), step("b", "in_progress")]);
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]?.type).toBe("context");
    expect(linesOf([step("a"), step("b", "in_progress")])).toEqual(["✅ Step a", "⏳ Step b"]);
    expect(view.text).toContain("2 steps");
  });

  test("shows the last few finished steps and counts the rest", () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(String(i)));
    const lines = linesOf(steps);
    expect(lines[0]).toBe("_…and 7 more steps_");
    expect(lines).toHaveLength(1 + STATUS_FINISHED_SHOWN);
    expect(lines.at(-1)).toBe("✅ Step 11");
    expect(lines.join("\n")).not.toContain("Step 6");
  });

  test("a step in progress is never hidden behind finished ones", () => {
    const steps = [step("slow", "in_progress"), ...Array.from({ length: 10 }, (_, i) => step(String(i)))];
    const lines = linesOf(steps);
    expect(lines).toContain("⏳ Step slow");
    expect(lines[0]).toMatch(/and 5 more steps/);
  });

  test("a burst of running steps is capped too, newest kept", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(String(i), "in_progress"));
    const lines = linesOf(steps);
    expect(lines).toHaveLength(1 + STATUS_RUNNING_SHOWN);
    expect(lines[0]).toBe("_…and 12 more steps_");
    expect(lines.at(-1)).toBe("⏳ Step 19");
  });

  test("one hidden step reads in the singular", () => {
    const steps = Array.from({ length: STATUS_FINISHED_SHOWN + 1 }, (_, i) => step(String(i)));
    expect(linesOf(steps)[0]).toBe("_…and 1 more step_");
  });

  test("stays under the block text limit however long the titles", () => {
    const steps = Array.from({ length: 30 }, (_, i) => step(String(i), i % 2 ? "complete" : "in_progress", "y".repeat(500)));
    const text = (renderStatus(steps).blocks[0] as unknown as { elements: { text: string }[] }).elements[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(STATUS_TEXT_BUDGET + 40);
    expect(text.length).toBeLessThan(3_000);
  });

  test("the thinking line is shown only while there is no step", () => {
    expect(linesOf([], "working on it...")).toEqual(["⏳ working on it..."]);
    expect(linesOf([step("a")], "working on it...")).toEqual(["✅ Step a"]);
  });
});

describe("what is left when the turn ends", () => {
  test("nothing, when every step worked", () => {
    expect(finalStatus([step("a"), step("b"), step("c")])).toBeUndefined();
    expect(finalStatus([])).toBeUndefined();
  });

  test("one summary line and the failures in full, when a step failed", () => {
    const view = finalStatus([step("a"), step("b", "error", "Run: gh pr view"), step("c")]);
    expect(view?.text).toBe("🔧 3 steps, 1 failed");
    const text = (view?.blocks[0] as unknown as { elements: { text: string }[] }).elements[0]?.text;
    expect(text).toBe("🔧 3 steps, 1 failed\n• Run: gh pr view");
  });

  test("a lone failed step is kept, unlike a lone clean one", () => {
    expect(finalStatus([step("a", "error", "Run: gh pr view")])?.text).toBe("🔧 1 steps, 1 failed");
  });

  test("a step still marked running when the turn ended is not a failure", () => {
    expect(finalStatus([step("a"), step("b", "in_progress")])).toBeUndefined();
  });

  test("failure text is escaped", () => {
    const view = finalStatus([step("a"), step("b", "error", "Run: <!channel>")]);
    expect(JSON.stringify(view?.blocks)).not.toContain("<!channel>");
  });
});
