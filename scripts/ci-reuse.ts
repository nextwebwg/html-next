// Reuse only a successful, same-PR validation of identical effective test inputs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Context {
  repository: string; headRepository: string; pullRequest: number; workflow: string;
  image: string; node: string; kernel: string; runnerImage: string;
}
interface Run {
  id: number; head_sha: string; run_attempt: number; status: string; conclusion: string | null; event: string; path: string;
  head_repository: { full_name: string } | null; pull_requests: { number: number }[];
}
interface Receipt extends Context {
  version: number; digest: string; run: number; attempt: number; testedCommit: string; testedTree: string;
}

// Only prose is outside the browser input boundary. Unknown paths, fixtures, shared
// configuration, scripts, dependency manifests and generated targets remain inputs.
export function prose(path: string): boolean {
  return /(?:^|\/)(?:README|CHANGELOG|AGENTS|CLAUDE)\.md$/.test(path)
    || /^packages\/[^/]+\/docs\/.*\.md$/.test(path);
}
export function inputDigest(entries: readonly string[], selection: unknown, context: Context): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, context, selection,
    inputs: entries.filter((entry) => !prose(entry.slice(entry.indexOf("\t") + 1))).sort() })).digest("hex");
}
export function reusableReceipt(value: unknown, run: Run, digest: string, context: Context): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Receipt;
  return receipt.version === 1 && receipt.digest === digest && receipt.run === run.id && receipt.attempt === run.run_attempt
    && /^[a-f0-9]{40}$/.test(receipt.testedCommit) && /^[a-f0-9]{40}$/.test(receipt.testedTree)
    && Object.entries(context).every(([key, entry]) => receipt[key as keyof Context] === entry)
    && run.status === "completed" && run.conclusion === "success" && run.event === "pull_request"
    && run.path === context.workflow && run.head_repository?.full_name === context.headRepository
    && run.pull_requests.some(({ number }) => number === context.pullRequest);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const command = (name: string, args: string[]) => execFileSync(name, args, { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const git = (...args: string[]) => command("git", args).trim();
let lookupDeadline = Infinity;
const api = (path: string) => {
  if (Date.now() >= lookupDeadline) throw new Error("Receipt lookup budget reached");
  return JSON.parse(command("gh", ["api", path]));
};
const output = (name: string, value: string) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};

async function main() {
  const mode = process.argv[2];
  if (mode === "finalize") {
    const receipt = process.env.CI_RECEIPT;
    if (!receipt) return;
    try {
    const jobs = api(`repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`).jobs as { name: string; conclusion: string; steps: { name: string; conclusion: string }[] }[];
    const selection = JSON.parse(process.env.CI_BROWSER_PLAN ?? '{"include":[]}').include as { name: string }[];
    const matched = selection.length > 0 && selection.every(({ name }) => jobs.some((job) => job.name === `Browser ${name}`
      && job.conclusion === "success" && job.steps.some((step) => step.name === "Reusable environment matches" && step.conclusion === "success")));
    if (matched) output("receipt", receipt);
    } catch (error) { console.warn(`No browser receipt published: ${String(error)}`); }
    return;
  }
  if (mode === "check-environment") {
    // Host kernels/runner-image revisions can change despite a pinned container.
    // A matrix on a different host/kernel still tests, but cannot publish a receipt.
    if (git("rev-parse", "HEAD") !== process.env.CI_TESTED_COMMIT
      || process.versions.node !== process.env.CI_BROWSER_NODE
      || command("uname", ["-r", "-m"]).trim() !== process.env.CI_HOST_KERNEL
      ) {
      output("eligible", "false");
    } else output("eligible", "true");
    return;
  }
  const environment = JSON.parse(readFileSync(join(root, "scripts/ci-browser-environment.json"), "utf8")) as { image: string; node: string };
  if (!/^mcr\.microsoft\.com\/playwright:v[\d.]+-noble@sha256:[a-f0-9]{64}$/.test(environment.image)) throw new Error("An immutable browser image is required");
  if (!/^\d+\.\d+\.\d+$/.test(environment.node)) throw new Error("An exact browser Node version is required");
  const locked = /playwright:\s*\n\s*specifier:.*\n\s*version: ([\d.]+)/.exec(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"))?.[1];
  if (!locked || !environment.image.startsWith(`mcr.microsoft.com/playwright:v${locked}-noble@`)) {
    throw new Error("Update the immutable browser image together with locked Playwright");
  }
  const selection = JSON.parse(process.env.CI_BROWSER_PLAN ?? '{"include":[]}');
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const context: Context = { repository: process.env.GITHUB_REPOSITORY ?? "", headRepository: event.pull_request?.head?.repo?.full_name ?? "",
    pullRequest: event.pull_request?.number ?? 0, workflow: ".github/workflows/ci.yml", ...environment,
    kernel: process.env.CI_RECEIPT_KERNEL ?? command("uname", ["-r", "-m"]).trim(), runnerImage: process.env.CI_RECEIPT_RUNNER_IMAGE ?? process.env.ImageVersion ?? "" };
  const testedCommit = git("rev-parse", "HEAD"), testedTree = git("rev-parse", "HEAD^{tree}");
  const digest = inputDigest(git("ls-tree", "-rz", "HEAD").split("\0").filter(Boolean), selection, context);
  const receipt: Receipt = { version: 1, ...context, digest, testedCommit, testedTree,
    run: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  const path = join(process.env.RUNNER_TEMP ?? tmpdir(), "browser-validation.json");
  writeFileSync(path, JSON.stringify(receipt, null, 2));
  output("image", environment.image); output("node", environment.node);
  output("kernel", context.kernel); output("runner_image", context.runnerImage); output("tested_commit", testedCommit);
  output("reused", "false");
  if (mode === "write-receipt" || !context.pullRequest || !context.runnerImage || !selection.include?.length) return;
  try {
    lookupDeadline = Date.now() + 20_000;
    const runs = api(`repos/${context.repository}/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=10`).workflow_runs as Run[];
    for (const run of runs) {
      if (run.id === receipt.run || run.path !== context.workflow || run.head_repository?.full_name !== context.headRepository
        || !run.pull_requests.some(({ number }) => number === context.pullRequest)) continue;
      // A PR can edit its own workflow. Authenticate the receipt-producing code
      // against GitHub's recorded branch head, not a SHA asserted inside the artifact.
      const tree = api(`repos/${context.repository}/git/trees/${run.head_sha}?recursive=1`) as { truncated: boolean; tree: { path: string; sha: string }[] };
      const authority = [context.workflow, "scripts/ci-reuse.ts", "scripts/ci-plan.ts", "scripts/ci-browser-environment.json"];
      if (tree.truncated || !authority.every((path) => tree.tree.some((entry) => entry.path === path
        && entry.sha === git("rev-parse", `HEAD:${path}`)))) continue;
      const artifacts = api(`repos/${context.repository}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts as { id: number; name: string; expired: boolean; size_in_bytes: number }[];
      const artifact = artifacts.find((entry) => entry.name === "browser-validation-v1" && !entry.expired && entry.size_in_bytes <= 65536);
      if (!artifact) continue;
      const directory = mkdtempSync(join(tmpdir(), "browser-receipt-"));
      try {
        if (Date.now() >= lookupDeadline) throw new Error("Receipt lookup budget reached");
        const archive = execFileSync("gh", ["api", `repos/${context.repository}/actions/artifacts/${artifact.id}/zip`], { timeout: 15_000, maxBuffer: 65536 });
        const zip = join(directory, "receipt.zip"); writeFileSync(zip, archive);
        const value = JSON.parse(command("unzip", ["-p", zip, "browser-validation.json"]));
        // Re-read current run state: a rerun must not inherit an earlier attempt's receipt.
        const current = api(`repos/${context.repository}/actions/runs/${run.id}`) as Run;
        if (!reusableReceipt(value, current, digest, context)) continue;
        // Resolve the asserted synthetic merge independently. API run.head_sha is
        // usually the PR branch head, not the checkout's tested merge commit.
        const commit = api(`repos/${context.repository}/git/commits/${value.testedCommit}`) as {
          sha: string; tree: { sha: string }; parents: { sha: string }[];
        };
        if (commit.tree.sha !== value.testedTree || !(commit.sha === current.head_sha
          || commit.parents.some((parent) => parent.sha === current.head_sha))) continue;
        const tested = api(`repos/${context.repository}/git/trees/${commit.tree.sha}?recursive=1`) as {
          truncated: boolean; tree: { mode: string; type: string; sha: string; path: string }[];
        };
        if (tested.truncated || inputDigest(tested.tree.filter((entry) => entry.type !== "tree")
          .map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`), selection, context) !== digest) continue;
        output("reused", "true");
        const url = `https://github.com/${context.repository}/actions/runs/${run.id}`;
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          `Browser suites reuse [successful run ${run.id}](${url}), attempt ${current.run_attempt}.\n\nInput digest: \`${digest}\`. Tested merge commit: \`${value.testedCommit}\`. Repository and non-browser checks run again.\n`);
        return;
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  } catch (error) {
    // API denial, unavailable tools, missing/expired artifacts and malformed data
    // are cache misses, never reasons to skip selected browser regressions.
    console.warn(`Browser receipt unavailable; running selected suites: ${String(error)}`);
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
