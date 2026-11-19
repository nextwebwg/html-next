import { spawnSync } from "node:child_process";

const result = spawnSync("corepack", ["pnpm", "exec", "vitest", "run", "packages/html-next-unplugin/tests/dotnet-hydration.test.ts", "--maxWorkers=1", "--no-file-parallelism"], {
  cwd: new URL("../", import.meta.url), env: { ...process.env, HTMLNEXT_DOTNET_TEST: "1" },
  stdio: "inherit", shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
