#!/usr/bin/env bun
//
// Mints a proxy session for a sandboxed process (see src/domain/sandboxSession.ts).
//
//   sandbox-session.ts mint <secret-file> <hours>   print a session token; creates the secret file (0600) when it is missing
//
// Run by bin/sandboxed.sh BEFORE the sandbox starts: the secret file lives under
// ~/.config/jarvis, which the sandbox cannot read. Exit: 0 printed, 1 failed, 2 usage.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { mintSession } from "../src/domain/sandboxSession.ts";

const [cmd, file, hoursArg] = process.argv.slice(2);
const hours = Number(hoursArg ?? "12");
if (cmd !== "mint" || !file || !Number.isFinite(hours) || hours <= 0) {
  console.error("usage: sandbox-session.ts mint <secret-file> <hours>");
  process.exit(2);
}
try {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const secret = readFileSync(file, "utf8").trim();
  console.log(mintSession(secret, Math.floor(Date.now() / 1000) + Math.round(hours * 3600)));
} catch (e) {
  console.error(`sandbox-session: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
