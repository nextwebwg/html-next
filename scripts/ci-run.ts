import { spawnSync } from "node:child_process";

interface Job { suite: string; package: string; files: string[]; pattern?: string }
const job = JSON.parse(process.env.CI_JOB ?? "null") as Job | null;
if (!job || job.files.length === 0) throw new Error("An explicit, nonempty test selection is required");

function pnpm(...args: string[]) {
  const result = spawnSync("corepack", ["pnpm", ...args], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (job.suite === "node") {
  pnpm("--filter", `@nextwebwg/${job.package}`, "typecheck");
}
const config = job.suite === "targets" ? "vitest.targets.config.ts"
  : job.suite === "browser" ? "vitest.browser.config.ts" : "vitest.config.ts";
pnpm("exec", "vitest", "run", "--config", config, ...job.files,
  "--maxWorkers", job.suite === "node" ? "2" : "1",
  ...(job.pattern ? ["--testNamePattern", job.pattern] : []));
