import { describe, expect, test } from "bun:test";
import { renderMcpTypes, schemaToType } from "../../src/domain/mcpTypes.ts";

describe("schemaToType", () => {
  test("primitives, arrays, enums, const and nullable", () => {
    expect(schemaToType({ type: "string" })).toBe("string");
    expect(schemaToType({ type: "integer" })).toBe("number");
    expect(schemaToType({ type: "boolean" })).toBe("boolean");
    expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(schemaToType({ type: "array" })).toBe("unknown[]");
    expect(schemaToType({ enum: ["a", "b", 3] })).toBe('"a" | "b" | 3');
    expect(schemaToType({ const: "x" })).toBe('"x"');
    expect(schemaToType({ type: ["string", "null"] })).toBe("string | null");
    expect(schemaToType({ type: "string", nullable: true })).toBe("string | null");
  });

  test("anyOf and oneOf become unions, parenthesised inside an array; allOf an intersection", () => {
    expect(schemaToType({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
    expect(schemaToType({ type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } })).toBe("(string | number)[]");
    expect(schemaToType({ allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] })).toContain("} & {");
  });

  test("objects: required vs optional, quoted keys, property docs, additionalProperties", () => {
    const t = schemaToType({
      type: "object",
      properties: { sql: { type: "string", description: "the query" }, "max-rows": { type: "integer" } },
      required: ["sql"],
    });
    expect(t).toContain("sql: string;");
    expect(t).toContain('"max-rows"?: number;');
    expect(t).toContain("/**\n   *  the query\n   */".replace("*  ", "* ").replace("   /**", "  /**").replace("\n   *", "\n   *"));
    expect(schemaToType({ type: "object", additionalProperties: { type: "number" } })).toBe("Record<string, number>");
    expect(schemaToType({ type: "object", additionalProperties: false })).toBe("Record<string, never>");
    expect(schemaToType({ type: "object" })).toBe("Record<string, unknown>");
  });

  test("tuples, nesting, and anything it does not understand is unknown", () => {
    expect(schemaToType({ type: "array", items: [{ type: "string" }, { type: "number" }] })).toBe("[string, number]");
    expect(schemaToType({ $ref: "#/definitions/x" })).toBe("unknown");
    expect(schemaToType(undefined)).toBe("unknown");
    expect(schemaToType(true)).toBe("unknown");
    expect(schemaToType({ anyOf: [{ type: "string" }, {}] })).toBe("unknown");
    // a schema nested past the depth limit is cut to unknown rather than recursing forever
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 20; i++) deep = { type: "array", items: deep };
    expect(schemaToType(deep)).toContain("unknown");
  });
});

describe("renderMcpTypes", () => {
  const tools = [
    { name: "run_query", description: "Run a SQL query\nand return rows */ end", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
    { name: "list-tables", description: "", inputSchema: { type: "object" } },
  ];

  test("one namespace per server, one async function per tool, docs as JSDoc, output unknown", () => {
    const out = renderMcpTypes([{ name: "pg", tools }]);
    expect(out).toContain("declare const mcp: {");
    expect(out).toContain("  pg: {");
    expect(out).toContain("run_query(args: {");
    expect(out).toContain("sql: string;");
    expect(out).toContain("}): Promise<unknown>;");
    expect(out).toContain("Run a SQL query");
    // a comment terminator in a description cannot break out of the JSDoc
    expect(out).not.toContain("rows */ end");
    // a tool with nothing required has an optional argument, a non-identifier name is quoted
    expect(out).toContain('"list-tables"(args?: Record<string, unknown>): Promise<unknown>;');
  });

  test("a server with no tools left (all unapproved or denied) is not emitted", () => {
    const out = renderMcpTypes([{ name: "pg", tools }, { name: "empty", tools: [] }]);
    expect(out).toContain("pg: {");
    expect(out).not.toContain("empty");
  });
});
