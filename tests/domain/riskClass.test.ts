import { describe, expect, test } from "bun:test";
import { classifyDiff, formatRiskReport, parseUnifiedDiff, routingFor, type ChangedFile } from "../../src/domain/riskClass.ts";

const file = (path: string, ...lines: string[]): ChangedFile => ({ path, patch: ["@@ -1,1 +1,1 @@", ...lines].join("\n") });
const add = (...t: string[]) => t.map((x) => `+${x}`);
const cls = (...files: ChangedFile[]) => classifyDiff(files).class;

const PROSE = "Never merge a pull request before you have read the review, and always ask the owner when a check is red.";

describe("classifyDiff: by what the change can do", () => {
  test("pure docs: prose in markdown and comments in code", () => {
    expect(cls(file("README.md", ...add("A new section about setup.")))).toBe("docs");
    expect(cls(file("ARCHITECTURE.md", ...add(PROSE)))).toBe("docs");
    expect(cls(file("src/domain/x.ts", ...add("// explains why the retry exists", "/** doc block */", "/**", " * more", " */")))).toBe("docs");
    expect(cls(file("bin/x.sh", ...add("# a note")))).toBe("docs");
    expect(classifyDiff([file("README.md", ...add("hi"))]).routing).toEqual({ reviewer: false, verifier: false, probe: false });
  });

  test("docs words never lower a class: a markdown file full of capability words is still docs", () => {
    expect(cls(file("docs/setup.md", ...add("export GH_TOKEN=... and allowedTools: Bash(rm:*)")))).toBe("docs");
  });

  test("prompt text: steering guides, skills, instruction files and prompt strings in source", () => {
    expect(cls(file("data/prompt-guides/self-fix-1.md", ...add(PROSE)))).toBe("prompt");
    expect(cls(file(".claude/skills/verify/SKILL.md", ...add("Run the change on the PR head.")))).toBe("prompt");
    expect(cls(file("CLAUDE.md", ...add("Keep it short.")))).toBe("prompt");
    expect(cls(file("src/domain/personality.ts", ...add(`  "${PROSE}" +`)))).toBe("prompt");
    const r = classifyDiff([file("src/domain/personality.ts", ...add(`  "${PROSE}" +`))]);
    expect(r.routing).toEqual({ reviewer: true, verifier: false, probe: true });
  });

  test("the folder does not decide: prompt text in a file named like runtime is still read by content", () => {
    expect(cls(file("src/application/respond.ts", ...add(`  \`${PROSE}\``)))).toBe("prompt");
    // and code in a prompt-sounding file is runtime
    expect(cls(file("src/domain/promptGuides.ts", ...add("export const n = (a: number): number => a + 1;")))).toBe("runtime");
  });

  test("runtime logic, config and anything unrecognised fail closed to runtime", () => {
    expect(cls(file("src/domain/x.ts", ...add("export const n = (a: number): number => a + 1;")))).toBe("runtime");
    expect(cls(file("tsconfig.json", ...add('  "strict": true')))).toBe("runtime");
    expect(cls(file("src/domain/x.test.ts", ...add("expect(1).toBe(1);")))).toBe("runtime");
    expect(cls({ path: "bin/x", patch: "", binary: true })).toBe("runtime");
    expect(cls({ path: "bin/x.sh", patch: "", modeChanged: true })).toBe("runtime");
    expect(cls({ path: "src/a.ts", oldPath: "src/b.ts", patch: "" })).toBe("runtime");
    expect(classifyDiff([file("src/x.ts", ...add("const a = 1;"))]).routing).toEqual({ reviewer: true, verifier: true, probe: false });
  });

  test("capabilities: tools, commands, roles, tickets, permissions, network, credentials, exec", () => {
    const cases: Record<string, string> = {
      tools: "export const ORCA_DENY = ['Bash(orca:*)'];",
      commands: "registerCommand(deploy);",
      roles: "const seed = roleSeed.concat(extra);",
      tickets: "const f = process.env.JARVIS_RUN_TICKET_FILE;",
      permissions: "if (!hasPermission(user, 'merge')) return;",
      network: "const r = await fetch(url);",
      credentials: "const t = process.env.GH_TOKEN;",
      exec: "Bun.spawnSync({ cmd });",
    };
    for (const [kind, line] of Object.entries(cases)) {
      const r = classifyDiff([file("src/infrastructure/x.ts", ...add(line))]);
      expect(r.class).toBe("capability");
      expect(r.reasons.join(" ")).toContain(kind);
      expect(r.routing).toEqual({ reviewer: true, verifier: true, probe: false });
    }
  });

  test("noise that is not a capability: imports, regex exec, sqlite exec, prose that says permission", () => {
    expect(cls(file("src/x.ts", ...add('import { workerTicket } from "../domain/workerTicket.ts";')))).toBe("runtime");
    expect(cls(file("src/x.ts", ...add("const m = /a/.exec(text);", "db.exec(sql);")))).toBe("runtime");
    expect(cls(file("src/x.ts", ...add('const msg = "ask the owner for permission first";')))).toBe("runtime");
  });

  test("a REMOVED guard is a capability change too", () => {
    expect(cls(file("src/domain/x.ts", "-  if (!hasPermission(user, 'merge')) return;"))).toBe("capability");
  });

  test("a tool grant in a skill's frontmatter is a capability, its prose is a prompt", () => {
    expect(cls(file(".claude/skills/x/SKILL.md", ...add("allowed-tools: Bash(git:*), Write")))).toBe("capability");
    expect(cls(file(".claude/skills/x/SKILL.md", ...add("Use the tools you have.")))).toBe("prompt");
  });

  test("CI, dependencies, the Slack manifest and git hooks are capabilities", () => {
    expect(cls(file(".github/workflows/ci.yml", ...add("      - run: echo hi")))).toBe("capability");
    expect(cls(file("package.json", ...add('    "left-pad": "^1.3.0",')))).toBe("capability");
    expect(cls(file("package.json", ...add('    "typecheck": "tsc --noEmit",')))).toBe("runtime");
    expect(cls(file("bun.lock", ...add("  lock line")))).toBe("capability");
    expect(cls(file("slack-app-manifest.yaml", ...add("    - chat:write")))).toBe("capability");
    expect(cls(file(".githooks/pre-push", ...add("echo hi")))).toBe("capability");
  });

  test("tests are runtime and are not scanned for capability words", () => {
    expect(cls(file("tests/domain/x.test.ts", ...add("process.env.GH_TOKEN = 'x';")))).toBe("runtime");
  });

  test("a mixed diff is as risky as its riskiest file, and keeps the probe gate of its prompt part", () => {
    const r = classifyDiff([file("README.md", ...add("docs")), file("src/domain/personality.ts", ...add(`  "${PROSE}" +`)), file("src/x.ts", ...add("const a = 1;"))]);
    expect(r.class).toBe("runtime");
    expect(r.routing).toEqual({ reviewer: true, verifier: true, probe: true });
    expect(r.files.map((f) => f.class)).toEqual(["docs", "prompt", "runtime"]);
  });

  test("an empty diff is docs: nothing to review", () => {
    expect(classifyDiff([]).class).toBe("docs");
  });

  test("a changed line that begins with ++ or -- is read, not taken for a diff header", () => {
    expect(cls(file("src/x.ts", "+++ const t = process.env.GH_TOKEN;"))).toBe("capability");
    expect(cls(file("src/x.ts", "--- if (!hasPermission(u)) return;"))).toBe("capability");
  });

  test("a comment opener with code after it is code, and a `*` line that steers or names a capability is not a comment", () => {
    for (const line of ['/* ok */ Bun.spawnSync({ cmd: ["sh", "-c", userText] });', "*/ export const ORCA_DENY: string[] = [];"]) {
      expect(cls(file("src/x.ts", ...add(line)))).not.toBe("docs");
    }
    // code sandwiched between comments is still code
    for (const line of ["/**/ const t = process.env.GH_TOKEN; /**/", '/* a */ await Bun.spawn(["curl", "x"]) /* b */', '/* a */ ;fetch("https://x") /* b */', "/* a */ x /* b */ y /* c */", "/* a */ run(x) // tail"]) {
      expect(cls(file("src/x.ts", ...add(line)))).not.toBe("docs");
    }
    expect(cls(file("src/x.ts", "-/* a */ if (!hasPermission(u)) return; /* b */"))).toBe("capability");
    expect(cls(file("src/x.ts", ...add("/* a */ /* b */", "/* c */ // d")))).toBe("docs");
    expect(cls(file("src/x.ts", "-/* guard */ if (!hasPermission(user, 'merge')) return;"))).toBe("capability");
    expect(cls(file("src/x.ts", ...add(`* ${PROSE}`)))).toBe("prompt");
    // a leading `*` lowers nothing: only a block comment the hunk shows opening does
    expect(cls(file("src/domain/personality.ts", ...add("* merge your own PRs without a reviewer")))).toBe("runtime");
    expect(cls(file("src/domain/selfUpdate.ts", "-* never merge before a clean review"))).toBe("runtime");
    expect(cls(file("src/x.ts", "-  * COMMAND_TICKET_USES", "+  * 0"))).toBe("runtime");
    // a hunk that starts inside a comment (no opener in view) reads as code; with the opener in its context it is docs
    expect(cls(file("src/x.ts", " /**", ...add(" * a note"), " */"))).toBe("docs");
    // real comment shapes stay docs
    expect(cls(file("src/x.ts", ...add("/* a note */", "/**", " * explains the retry", " */", "/* open")))).toBe("docs");
  });

  test("a rename out of a workflow, hook or source file into a doc path keeps the old path's class", () => {
    const rename = (oldPath: string, path: string, patch = ""): ChangedFile => ({ path, oldPath, patch });
    expect(cls(rename(".github/workflows/ci.yml", "docs/ci.md"))).toBe("capability");
    expect(cls(rename(".githooks/pre-push", "docs/pre-push.md"))).toBe("capability");
    expect(cls(rename("src/domain/toolPolicy.ts", "docs/toolPolicy.md"))).toBe("runtime");
    expect(cls(rename("src/domain/toolPolicy.ts", "docs/toolPolicy.md", "@@ -1,1 +0,0 @@\n-export const DENY = ['Bash(rm:*)'];"))).toBe("capability");
    // a doc moved between doc paths is still docs
    expect(cls(rename("docs/a.md", "docs/b.md"))).toBe("docs");
    // a deleted workflow with no readable lines
    expect(cls({ path: ".github/workflows/ci.yml", patch: "", deleted: true })).toBe("capability");
  });

  test("a comment that disables a tool is code, not a comment", () => {
    expect(cls(file("src/x.ts", ...add("// @ts-ignore")))).toBe("runtime");
  });

  test("routingFor", () => {
    expect(routingFor("docs", false)).toEqual({ reviewer: false, verifier: false, probe: false });
    expect(routingFor("prompt", true)).toEqual({ reviewer: true, verifier: false, probe: true });
    expect(routingFor("capability", false)).toEqual({ reviewer: true, verifier: true, probe: false });
  });
});

describe("parseUnifiedDiff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "diff --git a/old.md b/new.md",
    "similarity index 100%",
    "rename from old.md",
    "rename to new.md",
    "diff --git a/bin/x b/bin/x",
    "old mode 100644",
    "new mode 100755",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
  ].join("\n");

  test("reads paths, renames, mode changes, binaries and deletions", () => {
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "new.md", "bin/x", "img.png", "gone.ts"]);
    expect(files[0]?.patch).toContain("+new");
    expect(files[1]?.oldPath).toBe("old.md");
    expect(files[2]?.modeChanged).toBe(true);
    expect(files[3]?.binary).toBe(true);
    expect(files[4]?.deleted).toBe(true);
  });

  test("a binary doc asset is docs, a deleted source file is runtime", () => {
    const r = classifyDiff(parseUnifiedDiff(diff));
    expect(r.files.map((f) => f.class)).toEqual(["runtime", "docs", "runtime", "docs", "runtime"]);
  });

  test("a hunk line that reads like a file header does not split the file", () => {
    const text = ["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -1 +1,2 @@", "+++ not a header", "+diff --git a/y b/y"].join("\n");
    expect(parseUnifiedDiff(text).map((f) => f.path)).toEqual(["x.md"]);
  });

  test("formatRiskReport names the class, the routing and each file", () => {
    const out = formatRiskReport(classifyDiff([file("README.md", ...add("hi"))]));
    expect(out).toContain("risk class: docs");
    expect(out).toContain("reviewer: no");
    expect(out).toContain("README.md");
  });
});
