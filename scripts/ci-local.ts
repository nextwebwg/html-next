// Run the same affected plan as CI, serially, including local edits and new files.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestJob } from "./ci-plan.js";
const root = fileURLToPath(new URL("../", import.meta.url));
function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status ?? 1}`);
}
const directory = mkdtempSync(join(tmpdir(), "html-next-affected-"));
try {
  const args = process.argv.slice(2), preview = args.includes("--plan");
  const base = args.filter((arg) => arg !== "--plan")[0] ?? "origin/main";
  const output = join(directory, "outputs");
  run(process.execPath, [join(root, "scripts/ci-plan.ts")], { ...process.env, CI_LOCAL: "1", CI_BASE: base, GITHUB_OUTPUT: output });
  if (!preview) {
    const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) =>
      [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const pnpm = (...commands: string[]) => run("corepack", ["pnpm", ...commands]);
    pnpm("lint"); pnpm("exec", "tsc", "-p", "tsconfig.json");
    pnpm("exec", "vitest", "run", "tests/ci.test.ts", "tests/ci-reuse.test.ts", "--maxWorkers", "1");
    pnpm("--filter", "@nextwebwg/html-next", "check:release");
    if (values.generated === "true") pnpm("check:generated");
    for (const kind of ["node", "browser"]) for (const job of JSON.parse(values[kind]!).include as TestJob[]) {
      run(process.execPath, [join(root, "scripts/ci-run.ts")], { ...process.env, CI_JOB: JSON.stringify(job) });
    }
    for (const name of JSON.parse(values.packages!) as string[]) {
      pnpm("--filter", `{./packages/${name}}...`, "build");
      run("corepack", ["pnpm", "test:package"], { ...process.env, HTMLNEXT_PACKAGE_TEST: name });
    }
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
