import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  "looma-root": { type: "string" }, "prepare-only": { type: "boolean" },
  prepared: { type: "boolean" }, "catalog-only": { type: "boolean" },
  target: { type: "string" }, shard: { type: "string" },
} });
const explicitCheckout = values["looma-root"] ?? process.env.LOOMA_ROOT;
const looma = resolve(explicitCheckout ?? resolve(root, ".context/looma-pressure"));
const env = { ...process.env, LOOMA_HTMLNEXT_ROOT: root,
  ...(values.target ? { LOOMA_TEST_TARGET: values.target } : {}) };
function run(command: string, args: string[], cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}
if (!existsSync(resolve(looma, "package.json"))) {
  if (values.prepared) throw new Error("Restore the prepared Looma checkout before running test shards.");
  const pin = JSON.parse(readFileSync(resolve(root, "tests/looma.json"), "utf8")) as { repository: string; revision: string };
  if (!/^[a-f0-9]{40}$/.test(pin.revision)) throw new Error("Pin Looma qualification to a complete commit SHA.");
  mkdirSync(looma, { recursive: true });
  run("git", ["init", "--quiet"], looma);
  run("git", ["remote", "add", "origin", `https://github.com/${pin.repository}.git`], looma);
  run("git", ["fetch", "--depth=1", "origin", pin.revision], looma);
  run("git", ["checkout", "--detach", "FETCH_HEAD"], looma);
}
if (!explicitCheckout) {
  const pin = JSON.parse(readFileSync(resolve(root, "tests/looma.json"), "utf8")) as { revision: string };
  const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: looma, encoding: "utf8" }).trim();
  if (current !== pin.revision) {
    if (values.prepared || execFileSync("git", ["status", "--porcelain"], { cwd: looma, encoding: "utf8" }).trim()) {
      throw new Error("The pinned Looma checkout differs from this gate. Prepare a clean checkout or explicitly select your development checkout with --looma-root.");
    }
    run("git", ["fetch", "--depth=1", "origin", pin.revision], looma);
    run("git", ["checkout", "--detach", "FETCH_HEAD"], looma);
  }
}
if (!values.prepared) {
  run("corepack", ["pnpm", "build"]);
  run("corepack", ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], looma);
  run(process.execPath, ["packages/looma/tests/run-pressure.mjs", "--prepare-only"], looma);
}
if (!values["prepare-only"]) {
  run(process.execPath, ["packages/looma/tests/run-pressure.mjs", "--prepared",
    ...(values.shard ? [`--shard=${values.shard}`] : []), ...positionals], looma);
  // CI's existing affected feature jobs are required alongside its catalog shards.
  // The local combined command runs the additional feature cases itself.
  if (!values["catalog-only"]) run("corepack", ["pnpm", "test:targets", "--maxWorkers=1"]);
}
