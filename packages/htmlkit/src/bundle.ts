import { Worker } from "node:worker_threads";

export interface BrowserBuild {
  readonly root: string;
  readonly base: string;
  readonly outDir: string;
  readonly sources: ReadonlyMap<string, string>;
}

/** Vite's build and dev APIs both use NODE_ENV. Keep the production build in its own realm. */
export function bundleBrowser(options: BrowserBuild): Promise<readonly string[]> {
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(source ? "./bundle-worker.ts" : "./bundle-worker.js", import.meta.url);
  const workerEntry = source ? new URL(`data:text/javascript,${encodeURIComponent(
    `import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; await tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)});`,
  )}`) : entry;
  return new Promise((resolve, reject) => {
    let replied = false;
    const worker = new Worker(workerEntry, { workerData: options, execArgv: [], env: { ...process.env, NODE_ENV: "production" } });
    worker.once("message", (reply: { inputs: string[] } | { error: string }) => {
      replied = true; void worker.terminate();
      if ("error" in reply) reject(new Error(reply.error)); else resolve(reply.inputs);
    });
    worker.once("error", reject);
    worker.once("exit", code => { if (!replied) reject(new Error(`Browser build worker exited without a result (code ${code}).`)); });
  });
}
