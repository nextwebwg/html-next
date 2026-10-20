import { availableParallelism } from "node:os";
import { Worker, type MessagePort } from "node:worker_threads";

import { HtmlDiagnosticError, type HtmlDiagnostic } from "./diagnostics.js";
import type { ComponentDefinition } from "./template.js";
import type { ComponentHost } from "./runtime.js";

export interface ServerPreparationOptions {
  /** Application adapter's absolute ESM module URL; it exports a named prepare function. */
  readonly module: string;
  readonly data?: unknown;
  /** Transferred to this render and closed on completion, rejection or cancellation. */
  readonly port?: MessagePort;
}
export interface ServerPreparationContext {
  readonly document: Document;
  readonly host: (element: Element) => ComponentHost | undefined;
  /** Drain existing reactive rendering and lower newly rendered component invocations. */
  readonly flush: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly data: unknown;
  readonly port: MessagePort | undefined;
}
export type ServerPreparation = (context: ServerPreparationContext) =>
  void | (() => void | PromiseLike<void>) | PromiseLike<void | (() => void | PromiseLike<void>)>;

export interface ServerRenderOptions {
  /** Validated definitions, for example from parseComponent or loadNodeComponents. */
  readonly definitions: readonly ComponentDefinition[];
  readonly url?: string;
  /** Typed caller inputs, keyed by selectors for authored component invocations. */
  readonly props?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Declared initial state, keyed by a selector for rendered component roots. */
  readonly state?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The application document's own head content, which the components' head declarations start from. */
  readonly head?: string;
  /** Runs after initial props/state, without connecting browser lifecycle. */
  readonly prepare?: ServerPreparationOptions;
  /** Cancels a queued render or terminates only its assigned worker. */
  readonly signal?: AbortSignal;
}

export interface RenderedComponents {
  readonly html: string;
  /**
   * The document head: the application's own elements, with the rendered components' head
   * declarations reconciled into it, set-aside elements in their templates, and a preload link for
   * each eager declared script, every managed element marked `data-component-head`.
   */
  readonly head: string;
  readonly css: string;
  /**
   * Component tags and their state names for the carrier delivering this compiled CSS: those each
   * component's own styles test, and those any `:state()` condition tests on it.
   */
  readonly styleOwnership: Readonly<Record<string, readonly string[]>>;
}

export interface ServerRenderRequest extends Omit<ServerRenderOptions, "signal"> {
  readonly html: string;
}

export type ServerRenderReply =
  | { readonly result: RenderedComponents }
  | { readonly error: { readonly name: string; readonly message: string; readonly diagnostic?: HtmlDiagnostic } };

interface Job {
  readonly request: ServerRenderRequest;
  readonly resolve: (result: RenderedComponents) => void;
  readonly reject: (error: unknown) => void;
  transferred: boolean;
}
interface RenderWorker { readonly worker: Worker; job?: Job | undefined }

/** Up to 8 workers by default: each holds its own jsdom and runtime in memory. */
let size = Math.min(availableParallelism(), 8);
const workers = new Set<RenderWorker>();
const queue: Job[] = [];

/**
 * How many render workers renderComponents keeps, at least 1. The default is the number of available
 * CPUs, up to 8. A smaller count takes effect as workers finish their renders.
 */
export function setRenderWorkers(count: number): void {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("Render workers must be a whole number of at least 1.");
  size = count;
  dispatch();
}

/** End every render worker. Renders in progress reject; the next render starts new workers. */
export async function closeRenderWorkers(): Promise<void> {
  const stopped = [...workers];
  workers.clear();
  for (const job of queue.splice(0)) job.reject(new Error("Component rendering worker exited without a result (renderer closed)."));
  for (const entry of stopped) {
    entry.job?.reject(new Error("Component rendering worker exited without a result (renderer closed)."));
    entry.job = undefined;
  }
  await Promise.all(stopped.map(entry => entry.worker.terminate()));
}

function start(): RenderWorker {
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(source ? "./server-worker.ts" : "./server-worker.js", import.meta.url);
  // Node 22 needs the TypeScript loader registered inside the worker before importing its entry.
  // A JavaScript bootstrap avoids depending on native TypeScript support in the supported LTS range.
  const workerEntry = source ? new URL(`data:text/javascript,${encodeURIComponent(
    `import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; await tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)});`,
  )}`) : entry;
  // Packaged workers are ordinary ESM. Do not inherit caller loader or --input-type flags.
  const pooled: RenderWorker = { worker: new Worker(workerEntry, { execArgv: [] }) };
  const { worker } = pooled;
  // An idle worker never keeps the process alive; a busy one does, until its render answers.
  worker.unref();
  worker.on("message", (reply: ServerRenderReply) => {
    const job = pooled.job;
    pooled.job = undefined;
    worker.unref();
    if (job !== undefined) {
      if ("result" in reply) job.resolve(reply.result);
      else job.reject(reply.error.diagnostic === undefined
        ? Object.assign(new Error(reply.error.message), { name: reply.error.name })
        : new HtmlDiagnosticError(reply.error.diagnostic));
    }
    dispatch();
  });
  // A worker that fails or exits is replaced by the next render; its own render rejects.
  const lost = (error: Error) => {
    if (!workers.delete(pooled)) return;
    pooled.job?.reject(error);
    pooled.job = undefined;
    dispatch();
  };
  worker.once("error", lost);
  worker.once("exit", (code) => lost(new Error(`Component rendering worker exited without a result (code ${code}).`)));
  workers.add(pooled);
  return pooled;
}

/** Give each queued render to an idle worker, starting workers up to the pool size. */
function dispatch(): void {
  while (queue.length > 0) {
    let idle = [...workers].find((entry) => entry.job === undefined);
    if (idle === undefined && workers.size < size) idle = start();
    if (idle === undefined) return;
    const job = queue.shift()!;
    idle.job = job;
    idle.worker.ref();
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node Worker has no origin argument.
      idle.worker.postMessage(job.request, job.request.prepare?.port === undefined ? [] : [job.request.prepare.port]);
      job.transferred = true;
    } catch (error) {
      idle.job = undefined;
      idle.worker.unref();
      job.reject(error);
    }
  }
  // Beyond a smaller size, idle workers end.
  for (const entry of workers) if (workers.size > size && entry.job === undefined) { workers.delete(entry); void entry.worker.terminate(); }
}

/**
 * Render in Node without executing page scripts or controller modules. A small pool of long-lived
 * workers renders one request at a time each. Every render gets its own JSDOM document and window,
 * browser globals, component registry, and component instances, which the worker discards after
 * the render; definitions and state arrive as structured clones. Workers share only loaded modules.
 */
export function renderComponents(html: string, options: ServerRenderOptions): Promise<RenderedComponents> {
  const { signal, ...request } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { request.prepare?.port?.close(); reject(signal.reason); return; }
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      if (!job.transferred) job.request.prepare?.port?.close();
    };
    const job: Job = { request: { ...request, html }, transferred: false,
      resolve: result => { finish(); resolve(result); }, reject: error => { finish(); reject(error); } };
    const abort = (): void => {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      const assigned = [...workers].find(entry => entry.job === job);
      if (assigned !== undefined) {
        workers.delete(assigned);
        assigned.job = undefined;
        void assigned.worker.terminate();
      }
      job.reject(signal!.reason);
      dispatch();
    };
    signal?.addEventListener("abort", abort, { once: true });
    queue.push(job);
    dispatch();
  });
}
