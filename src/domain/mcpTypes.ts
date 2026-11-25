/**
 * Pure part of `mcp types`: TypeScript declarations for a model-written `mcp run` script, generated from the tools'
 * JSON input schemas (the lazy proxy's schema cache). One `mcp.<server>` namespace per server, one async function per
 * tool, the input type from `inputSchema`, the description as JSDoc, the output `Promise<unknown>` (MCP tools do not
 * declare one). Anything the converter does not understand becomes `unknown`.
 */
import type { ToolInfo } from "./mcpCodeMode.ts";

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A property or tool name as an object key / member: bare when it is an identifier, else quoted. */
const key = (name: string): string => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

const MAX_DEPTH = 8;

const literal = (v: Json): string | undefined =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? JSON.stringify(v) : v === null ? "null" : undefined;

const union = (parts: readonly string[]): string => {
  const unique = [...new Set(parts)];
  if (unique.length === 0) return "unknown";
  return unique.includes("unknown") ? "unknown" : unique.join(" | ");
};
/** A type that needs parentheses inside an array type (`(A | B)[]`): it has a `|` or `&` outside any brackets. */
const paren = (t: string): string => {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === '"') quoted = !quoted;
    else if (c === "\\" && quoted) i++;
    else if (!quoted && "({[<".includes(c)) depth++;
    else if (!quoted && ")}]>".includes(c)) depth--;
    else if (!quoted && depth === 0 && (c === "|" || c === "&")) return `(${t})`;
  }
  return t;
};

const comment = (text: string | undefined, indent: string): string => {
  const lines = (text ?? "").replace(/\*\//g, "* /").split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (lines.length === 0) return "";
  return `${indent}/**\n${lines.map((l) => `${indent} *${l ? ` ${l}` : ""}`).join("\n")}\n${indent} */\n`;
};

const objectType = (schema: Record<string, Json>, depth: number, indent: string): string => {
  const props = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [];
  const names = Object.keys(props);
  const extra = schema.additionalProperties;
  const index = extra === undefined || extra === true ? "unknown" : isObject(extra) ? schemaToType(extra, depth + 1, indent) : undefined;
  if (names.length === 0) return index === undefined ? "Record<string, never>" : `Record<string, ${index}>`;
  const inner = `${indent}  `;
  const members = names.map((name) => {
    const p = props[name];
    const doc = isObject(p) && typeof p.description === "string" ? comment(p.description, inner) : "";
    return `${doc}${inner}${key(name)}${required.includes(name) ? "" : "?"}: ${schemaToType(p, depth + 1, inner)};`;
  });
  if (index !== undefined && schema.additionalProperties !== undefined) members.push(`${inner}[key: string]: ${index};`);
  return `{\n${members.join("\n")}\n${indent}}`;
};

/** A JSON Schema as a TypeScript type: object, array, enum / const, primitives, anyOf / oneOf / allOf, nullable; else `unknown`. */
export const schemaToType = (schema: Json, depth = 0, indent = ""): string => {
  if (schema === true || !isObject(schema) || depth > MAX_DEPTH) return "unknown";
  if (Array.isArray(schema.enum)) {
    const lits = schema.enum.map(literal);
    return lits.every((l) => l !== undefined) ? union(lits as string[]) : "unknown";
  }
  if (schema.const !== undefined) return literal(schema.const) ?? "unknown";
  for (const k of ["anyOf", "oneOf"] as const) {
    const options = schema[k];
    if (Array.isArray(options) && options.length > 0) return union(options.map((o) => schemaToType(o, depth + 1, indent)));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const parts = schema.allOf.map((o) => schemaToType(o, depth + 1, indent)).filter((t) => t !== "unknown");
    return parts.length === 0 ? "unknown" : parts.map(paren).join(" & ");
  }
  const type = schema.type;
  if (Array.isArray(type)) return union(type.map((t) => schemaToType({ ...schema, type: t }, depth + 1, indent)));
  const base = ((): string => {
    switch (type) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        if (Array.isArray(schema.items)) return `[${schema.items.map((i) => schemaToType(i, depth + 1, indent)).join(", ")}]`;
        return `${paren(schema.items === undefined ? "unknown" : schemaToType(schema.items, depth + 1, indent))}[]`;
      }
      case "object":
        return objectType(schema, depth, indent);
      default:
        // No type: an object when it has properties, else anything.
        return isObject(schema.properties) ? objectType(schema, depth, indent) : "unknown";
    }
  })();
  return schema.nullable === true && base !== "unknown" ? `${base} | null` : base;
};

/** A tool's input as the type of the one argument of its function. */
export const inputTypeOf = (tool: ToolInfo): string => schemaToType(tool.inputSchema ?? { type: "object" }, 0, "    ");

const hasRequired = (schema: Json): boolean => isObject(schema) && Array.isArray(schema.required) && schema.required.length > 0;

/** A server whose tools a script may use, as `mcp types` sees it: the tools left after approval gating and the deny list. */
export type TypesServer = { readonly name: string; readonly tools: readonly ToolInfo[] };

/**
 * The `declare const mcp: { ... }` text for the given servers. A server name or tool name that is not an identifier is
 * quoted, so the script reaches it as `mcp["my-server"]["my-tool"](...)`. A server with no usable tool is left out.
 */
export const renderMcpTypes = (servers: readonly TypesServer[]): string => {
  const blocks = servers
    .filter((s) => s.tools.length > 0)
    .map((s) => {
      const fns = s.tools.map((t) => {
        const arg = `args${hasRequired(t.inputSchema) ? "" : "?"}: ${inputTypeOf(t)}`;
        return `${comment(t.description, "    ")}    ${key(t.name)}(${arg}): Promise<unknown>;`;
      });
      return `  ${key(s.name)}: {\n${fns.join("\n")}\n  };`;
    });
  const header =
    "// Tools a `mcp run` script may call. Each resolves to the tool's JSON result (an object, or a string for a plain-text result)\n" +
    "// and throws when the tool reports an error. console.log is the script's output; the default export (or `return` of a default\n" +
    "// exported function) is its result.\n";
  return `${header}declare const mcp: {\n${blocks.join("\n")}\n};\n`;
};
