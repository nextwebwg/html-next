import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SkipTest, testSuite } from "reactive-framework-test-suite";
import { untracked } from "../src/reactivity.js";
import { htmlNextFramework } from "./reactivity-benchmark.js";

// Keep the full upstream suite optional. Its semantics include capabilities/design choices
// outside HTML Next's contract; failed, skipped, and behavioral cases must remain visible.
if (!process.argv.includes("--worker")) {
  process.stdout.write(execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--worker"],
    { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "inherit"] }));
} else {
  const cases = testSuite.flatMap(({ section, type, cases }) => Object.entries(cases).map(([name, run]) => {
    const framework = { ...htmlNextFramework(), untracked };
    try {
      let value: unknown;
      framework.run(() => { value = run(framework); });
      return { section, name, status: type === "behavioral" ? "behavioral" : "pass", value };
    } catch (error) {
      return { section, name, status: error instanceof SkipTest ? "skip" : "fail",
        reason: error instanceof Error ? error.message : String(error) };
    }
  }));
  process.stdout.write(`${JSON.stringify({
    framework: "HTML Next", upstreamVersion: "0.1.0", node: process.version,
    summary: Object.fromEntries(["pass", "fail", "skip", "behavioral"].map((status) => [status, cases.filter((entry) => entry.status === status).length])),
    cases,
  }, null, 2)}\n`);
}
