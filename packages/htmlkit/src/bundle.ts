import { Worker } from "node:worker_threads";

export interface BrowserBuild {
  readonly root: string;
  readonly base: string;
  readonly outDir: string;
  readonly sources: ReadonlyMap<string, string>;
}

/** The request server's own modules: loaders, endpoints, and middleware, each built to <name>.js in outDir. */
export interface ServerBuild {
  readonly root: string;
  readonly outDir: string;
  readonly inputs: Readonly<Record<string, string>>;
}
export interface ServerBundleEntry { readonly file: string; readonly exports: readonly string[] }
export interface BundleResult {
  readonly inputs: readonly string[];
  readonly entries: Readonly<Record<string, ServerBundleEntry>>;
}

/** Vite's build and dev APIs both use NODE_ENV. Keep each production build in its own realm. */
function inWorker(workerData: { readonly browser: BrowserBuild } | { readonly server: ServerBuild }, signal?: AbortSignal): Promise<BundleResult> {
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(source ? "./bundle-worker.ts" : "./bundle-worker.js", import.meta.url);
  const workerEntry = source ? new URL(`data:text/javascript,${encodeURIComponent(
    `import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; await tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)});`,
  )}`) : entry;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let replied = false;
    const worker = new Worker(workerEntry, { workerData, execArgv: [], env: { ...process.env, NODE_ENV: "production" } });
    const settle = (outcome: { result: BundleResult } | { error: unknown }): void => {
      if (replied) return;
      replied = true;
      signal?.removeEventListener("abort", abort);
      void worker.terminate().then(() => { if ("error" in outcome) reject(outcome.error); else resolve(outcome.result); }, reject);
    };
    const abort = (): void => settle({ error: signal!.reason });
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (reply: BundleResult | { error: string }) => settle("error" in reply ? { error: new Error(reply.error) } : { result: reply }));
    worker.once("error", error => settle({ error }));
    worker.once("exit", code => { if (!replied) settle({ error: new Error(`Build worker exited without a result (code ${code}).`) }); });
  });
}

export async function bundleBrowser(options: BrowserBuild): Promise<readonly string[]> { return (await inWorker({ browser: options })).inputs; }
export function bundleServer(options: ServerBuild, signal?: AbortSignal): Promise<BundleResult> { return inWorker({ server: options }, signal); }
