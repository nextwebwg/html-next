import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories = ["html-next", "html-next-converter", "html-next-unplugin", "htmlkit"];
const manifests = directories.map((directory) => ({ directory, ...JSON.parse(
  readFileSync(`${root}packages/${directory}/package.json`, "utf8"),
) as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } }));
const durations = JSON.parse(readFileSync(`${root}tests/target-durations.json`, "utf8")) as Record<string, number>;
// Seconds from CI run 38004501687. Leave room for container startup, install and collection.
Object.assign(durations, {
  "packages/html-next/tests/runtime.test.ts": 260,
  "packages/html-next/tests/server-hydration.test.ts": 217,
  "packages/htmlkit/tests/client-navigation.test.ts": 164,
  "packages/htmlkit/tests/browser.test.ts": 38,
});

export interface TestJob {
  name: string;
  package: string;
  suite: "node" | "browser" | "targets";
  files: string[];
  seconds: number;
  pattern?: string;
}

export function affectedPackages(paths: readonly string[]): string[] {
  const changed = new Set<string>();
  for (const path of paths) {
    if (path.startsWith("docs/") || /(?:^|\/)(?:README|CHANGELOG|AGENTS|CLAUDE)\.md$/.test(path)
      || /^packages\/[^/]+\/docs\//.test(path)) continue;
    const directory = /^packages\/([^/]+)\//.exec(path)?.[1];
    if (directory && directories.includes(directory)) changed.add(directory);
    // Shared toolchain changes, unknown paths and deleted files fail open to the full graph.
    else for (const name of directories) changed.add(name);
  }
  for (let previous = -1; previous !== changed.size;) {
    previous = changed.size;
    for (const manifest of manifests) {
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      if (manifests.some((dependency) => changed.has(dependency.directory) && dependency.name in dependencies)) {
        changed.add(manifest.directory);
      }
    }
  }
  return directories.filter((directory) => changed.has(directory));
}

export function createPlan(paths: readonly string[]) {
  const packages = affectedPackages(paths);
  const node: TestJob[] = [];
  const browser: TestJob[] = [];
  for (const directory of packages) {
    const unitFiles: string[] = [];
    const buckets: TestJob[] = [];
    const tests = readdirSync(`${root}packages/${directory}/tests`, { recursive: true }).map(String)
      .filter((path) => path.endsWith(".test.ts")).sort();
    for (const path of tests) {
      const file = `packages/${directory}/tests/${path}`;
      const source = readFileSync(`${root}${file}`, "utf8");
      const suite = source.includes("HTMLNEXT_BROWSER_TEST") ? "browser"
        : source.includes("HTMLNEXT_TARGET_TEST") ? "targets" : "node";
      if (source.includes("HTMLNEXT_CONSUMER_TEST")) continue; // Packed contracts run separately.
      if (suite === "node") { unitFiles.push(file); continue; }
      const seconds = durations[file] ?? 20;
      if (seconds > 180) {
        // Public converter corpora cover every engine and both application/library delivery.
        // Partition by full test name; the first partition also owns any unlabelled test.
        const labels = path === "svelte-public-conformance-parity.test.ts"
          ? ["Chromium application", "Chromium library", "Firefox application", "Firefox library", "WebKit application", "WebKit library"]
          : ["Chromium", "Firefox", "WebKit"];
        labels.forEach((label, index) => browser.push({
          name: `${directory} ${path} ${label}`, package: directory, suite, files: [file],
          seconds: Math.ceil(seconds / labels.length),
          pattern: index === 0 ? `${label}|^(?!.*(?:${labels.join("|")})).*$` : label,
        }));
      } else {
        let bucket = buckets.find((job) => job.suite === suite && job.seconds + seconds <= 180);
        if (!bucket) {
          bucket = { name: `${directory} ${suite} ${buckets.length + 1}`, package: directory, suite, files: [], seconds: 0 };
          buckets.push(bucket);
        }
        bucket.files.push(file);
        bucket.seconds += seconds;
      }
    }
    browser.push(...buckets);
    // Small Node batches avoid importing ~100 skipped browser specs and oversubscribing jsdom.
    for (let index = 0; index < unitFiles.length; index += 20) node.push({
      name: `${directory} node ${index / 20 + 1}`, package: directory, suite: "node",
      files: unitFiles.slice(index, index + 20), seconds: 0,
    });
  }
  return { packages, node, browser };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.env.CI_BASE;
  // A new branch's zero SHA cannot be diffed. Select everything rather than skip verification.
  const paths = !base || /^0+$/.test(base) ? ["pnpm-lock.yaml"] : execFileSync(
    "git", ["diff", "--name-only", "-z", base, "HEAD"], { cwd: root, encoding: "utf8" },
  ).split("\0").filter(Boolean);
  const plan = createPlan(paths);
  const outputs = {
    node: JSON.stringify({ include: plan.node }), browser: JSON.stringify({ include: plan.browser }),
    // The plugin's installed-consumer test also covers the converter; run it once.
    packages: JSON.stringify(plan.packages.filter((name) => name !== "html-next-converter")), has_node: String(plan.node.length > 0),
    has_browser: String(plan.browser.length > 0), has_packages: String(plan.packages.length > 0),
    generated: String(paths.includes("docs/guide/quick-start.md") || plan.packages.some((name) =>
      name === "html-next" || name === "html-next-converter")),
    playwright: /playwright:\s*\n\s*specifier:.*\n\s*version: ([\d.]+)/.exec(readFileSync(`${root}pnpm-lock.yaml`, "utf8"))?.[1],
  };
  if (!outputs.playwright) throw new Error("Missing locked Playwright version");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(""));
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
