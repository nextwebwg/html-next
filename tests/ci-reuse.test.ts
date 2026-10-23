import { describe, expect, it } from "vitest";
import { inputDigest, reusableReceipt } from "../scripts/ci-reuse.js";
const context = { repository: "nextwebwg/html-next", headRepository: "nextwebwg/html-next", pullRequest: 42,
  workflow: ".github/workflows/ci.yml", image: "image@sha256:abc", node: "24.15.0", kernel: "6.11 x86_64", runnerImage: "20261020.1" };
const plan = [{ name: "Chromium", files: ["runtime.test.ts"] }];
const inputs = ["100644 blob a\tpackages/htmlkit/src/a.ts", "100644 blob b\tCHANGELOG.md"];
const digest = inputDigest(inputs, plan, context);
const receipt = { version: 1, digest, ...context, run: 100, attempt: 1, testedCommit: "a".repeat(40), testedTree: "b".repeat(40) };
const run = { id: 100, head_sha: "c".repeat(40), run_attempt: 1, status: "completed", conclusion: "success", event: "pull_request",
  path: context.workflow, head_repository: { full_name: context.headRepository }, pull_requests: [{ number: 42 }] };
describe("successful browser validation reuse", () => {
  it("reuses success for identical inputs while ignoring prose", () => {
    expect(reusableReceipt(receipt, run, digest, context)).toBe(true);
    expect(inputDigest([inputs[0]!, "100644 blob c\tCHANGELOG.md"], plan, context)).toBe(digest);
  });
  it.each(["packages/htmlkit/src/a.ts", "pnpm-lock.yaml", ".github/workflows/ci.yml", "tests/shared.ts", "docs/fixture.html", "docs/guide/transitions.md", "docs/guide/quick-start.md"])("invalidates changed %s", (path) => {
    expect(inputDigest([...inputs, `100644 blob changed\t${path}`], plan, context)).not.toBe(digest);
  });
  it("includes base changes through the tested merge tree's inputs", () => {
    expect(inputDigest(["100644 blob base-change\tpackages/htmlkit/src/a.ts"], plan, context)).not.toBe(digest);
  });
  it.each(["image", "node", "kernel", "runnerImage", "headRepository", "repository", "pullRequest", "workflow"])("invalidates environment or trust change %s", (field) => {
    expect(inputDigest(inputs, plan, { ...context, [field]: "changed" })).not.toBe(digest);
  });
  it("invalidates changed selection", () => {
    expect(inputDigest(inputs, [...plan, { name: "WebKit", files: ["runtime.test.ts"] }], context)).not.toBe(digest);
  });
  it.each(["failure", "cancelled", "skipped", null])("rejects %s runs", (conclusion) => {
    expect(reusableReceipt(receipt, { ...run, conclusion }, digest, context)).toBe(false);
  });
  it("rejects unfinished runs, another attempt, PR, fork, workflow, digest and malformed receipts", () => {
    for (const change of [{ status: "in_progress" }, { run_attempt: 2 }, { pull_requests: [{ number: 43 }] },
      { head_repository: { full_name: "attacker/fork" } }, { path: "other.yml" }, { id: 101 }]) {
      expect(reusableReceipt(receipt, { ...run, ...change }, digest, context)).toBe(false);
    }
    for (const value of [null, {}, { ...receipt, digest: "wrong" }, { ...receipt, testedTree: "" }, { ...receipt, version: 2 }]) {
      expect(reusableReceipt(value, run, digest, context)).toBe(false);
    }
  });
});

// Exercise the command's actual API-failure boundary, rather than treating missing
// evidence as success. The executable fixture stands in for GitHub's CLI service.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
it("runs selected suites when discovery is unavailable or malformed", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-receipt-api-"));
  try {
    const event = join(directory, "event.json"), output = join(directory, "outputs");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 42, head: { repo: { full_name: "nextwebwg/html-next" } } } }));
    for (const fixture of ["exit 1", "echo invalid-json"]) {
      const gh = join(directory, process.platform === "win32" ? "gh.cmd" : "gh");
      writeFileSync(gh, `#!/bin/sh\n${fixture}\n`); chmodSync(gh, 0o755);
      writeFileSync(output, "");
      execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/ci-reuse.ts", import.meta.url))], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_EVENT_PATH: event,
          GITHUB_REPOSITORY: "nextwebwg/html-next", GITHUB_OUTPUT: output, GITHUB_RUN_ID: "200", GITHUB_RUN_ATTEMPT: "1",
          ImageVersion: "test-runner", CI_BROWSER_PLAN: JSON.stringify({ include: plan }) }, stdio: "pipe",
      });
      expect(readFileSync(output, "utf8")).toContain("reused=false\n");
      expect(readFileSync(output, "utf8")).not.toContain("reused=true");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("resolves a successful tested merge receipt, but reruns on cancelled, changed-base and missing evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-receipt-lookup-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    for (const name of ["scripts", ".github/workflows", "packages/example", "bin"]) mkdirSync(join(directory, name), { recursive: true });
    for (const name of ["ci-reuse.ts", "ci-browser-environment.json"]) writeFileSync(join(directory, "scripts", name),
      readFileSync(new URL(`../scripts/${name}`, import.meta.url)));
    writeFileSync(join(directory, "scripts/ci-plan.ts"), "// receipt authority\n");
    writeFileSync(join(directory, ".github/workflows/ci.yml"), "name: CI\n");
    writeFileSync(join(directory, "pnpm-lock.yaml"), "playwright:\n  specifier: 1.64.0\n  version: 1.64.0\n");
    writeFileSync(join(directory, "packages/example/source.ts"), "original");
    writeFileSync(join(directory, "CHANGELOG.md"), "original prose");
    git("init", "--quiet"); git("config", "user.name", "CI"); git("config", "user.email", "ci@example.test");
    git("add", "scripts", ".github", "pnpm-lock.yaml", "packages", "CHANGELOG.md");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture base");
    const base = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    const branch = git("commit-tree", tree, "-p", base, "-m", "PR branch");
    const merge = git("commit-tree", tree, "-p", base, "-p", branch, "-m", "Tested synthetic merge");
    git("update-ref", "HEAD", merge);
    const event = join(directory, "event.json"), output = join(directory, "outputs");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 42, head: { repo: { full_name: context.headRepository } } } }));
    const env = { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, RUNNER_TEMP: directory,
      GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: context.repository, GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", ImageVersion: "fixture-runner",
      CI_BROWSER_PLAN: JSON.stringify({ include: plan }) };
    const invoke = (mode?: string) => execFileSync(process.execPath, [join(directory, "scripts/ci-reuse.ts"), ...(mode ? [mode] : [])], { cwd: directory, env, stdio: "pipe" });
    invoke("write-receipt");
    execFileSync("zip", ["-q", "receipt.zip", "browser-validation.json"], { cwd: directory });
    const entries = git("ls-tree", "-rz", "HEAD").split("\0").filter(Boolean).map((entry) => {
      const [header, path] = entry.split("\t"), [mode, type, sha] = header!.split(" ");
      return { mode, type, sha, path };
    });
    const previous = { ...run, head_sha: branch };
    const apiData = join(directory, "api.json"), apiMode = join(directory, "mode");
    writeFileSync(apiData, JSON.stringify({ previous, entries, merge, tree, base, branch }));
    const gh = join(directory, "bin/gh");
    writeFileSync(gh, `#!/usr/bin/env node\nconst fs = require('node:fs');
const d = JSON.parse(fs.readFileSync(${JSON.stringify(apiData)}, 'utf8'));
const mode = fs.readFileSync(${JSON.stringify(apiMode)}, 'utf8');
const p = process.argv[3]; let result;
if (p.includes('workflows/ci.yml/runs')) result = {workflow_runs:[d.previous]};
else if (p.includes('/git/trees/')) result = {truncated:false,tree:d.entries};
else if (p.includes('/git/commits/')) result = {sha:d.merge,tree:{sha:mode==='wrong-tree'?'0'.repeat(40):d.tree},parents:[{sha:d.base},{sha:d.branch}]};
else if (p.includes('/artifacts/1/zip')) {process.stdout.write(fs.readFileSync(${JSON.stringify(join(directory, "receipt.zip"))}));process.exit(0);}
else if (p.endsWith('/artifacts?per_page=100')) result = {artifacts:mode==='missing'?[]:[{id:1,name:'browser-validation-v1',expired:false,size_in_bytes:1000}]};
else if (p.endsWith('/runs/100')) result = {...d.previous,...(mode==='cancelled'?{conclusion:'cancelled'}:{})};
else process.exit(1);
process.stdout.write(JSON.stringify(result));\n`); chmodSync(gh, 0o755);
    env.GITHUB_RUN_ID = "200";
    const lookup = (mode: string) => {
      writeFileSync(apiMode, mode); writeFileSync(output, ""); invoke();
      return readFileSync(output, "utf8").includes("reused=true\n");
    };
    expect(lookup("valid")).toBe(true);
    expect(lookup("cancelled")).toBe(false);
    expect(lookup("missing")).toBe(false);
    expect(lookup("wrong-tree")).toBe(false);
    writeFileSync(join(directory, "CHANGELOG.md"), "updated prose"); git("add", "CHANGELOG.md");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "prose follow-up");
    expect(lookup("valid")).toBe(true);
    writeFileSync(join(directory, "packages/example/source.ts"), "new base implementation"); git("add", "packages");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "changed merge input");
    expect(lookup("valid")).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
