import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOX_LIMITS, appendCapped, positiveInt, secondsToMs, wrapScript } from "../../src/domain/mcpSandbox.ts";

describe("sandbox limits and flags", () => {
  test("defaults are bounded", () => {
    expect(DEFAULT_SANDBOX_LIMITS.timeoutMs).toBe(60_000);
    expect(DEFAULT_SANDBOX_LIMITS.maxCalls).toBeGreaterThan(0);
    expect(DEFAULT_SANDBOX_LIMITS.memoryBytes).toBeGreaterThan(0);
  });

  test("secondsToMs and positiveInt take only positive numbers, the fallback when absent", () => {
    expect(secondsToMs(undefined, 5)).toBe(5);
    expect(secondsToMs("1.5", 5)).toBe(1500);
    expect(secondsToMs("0", 5)).toBeUndefined();
    expect(secondsToMs("abc", 5)).toBeUndefined();
    expect(positiveInt(undefined, 7)).toBe(7);
    expect(positiveInt("12", 7)).toBe(12);
    expect(positiveInt("1.5", 7)).toBeUndefined();
    expect(positiveInt("-1", 7)).toBeUndefined();
  });

  test("appendCapped stops at the cap and says so once", () => {
    const buf = { text: "", bytes: 0, truncated: false };
    for (let i = 0; i < 10; i++) appendCapped(buf, "0123456789", 35);
    expect(buf.text.match(/truncated/g)).toHaveLength(1);
    expect(buf.text.startsWith("0123456789\n0123456789\n0123456789\n")).toBe(true);
    expect(buf.bytes).toBeLessThanOrEqual(35);
  });

  test("wrapScript turns the default export into the script's value", () => {
    expect(wrapScript("export default async () => 1;")).toContain("globalThis.__default = async () => 1;");
    expect(wrapScript("console.log(1)")).not.toContain("__default =");
  });
});
