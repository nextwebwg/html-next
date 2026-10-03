import { Worker } from "node:worker_threads";

import { HtmlDiagnosticError, type HtmlDiagnostic } from "./diagnostics.js";
import type { ComponentDefinition } from "./template.js";

export interface ServerRenderOptions {
  /** Validated definitions, for example from parseComponent or loadNodeComponents. */
  readonly definitions: readonly ComponentDefinition[];
  readonly url?: string;
  /** Declared initial state, keyed by a selector for rendered component roots. */
  readonly state?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface RenderedComponents {
  readonly html: string;
  readonly css: string;
}

export interface ServerRenderRequest extends ServerRenderOptions {
  readonly html: string;
}

export type ServerRenderReply =
  | { readonly result: RenderedComponents }
  | { readonly error: { readonly name: string; readonly message: string; readonly diagnostic?: HtmlDiagnostic } };

/**
 * Render in Node without executing page scripts or controller modules. Each request owns a DOM and
 * a worker realm; the caller's globals and other requests cannot share browser constructors or state.
 */
export function renderComponents(html: string, options: ServerRenderOptions): Promise<RenderedComponents> {
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(source ? "./server-worker.ts" : "./server-worker.js", import.meta.url);
  // Node 22 needs the TypeScript loader registered inside the worker before importing its entry.
  // A JavaScript bootstrap avoids depending on native TypeScript support in the supported LTS range.
  const workerEntry = source ? new URL(`data:text/javascript,${encodeURIComponent(
    `import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; await tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)});`,
  )}`) : entry;
  return new Promise((resolve, reject) => {
    let replied = false;
    const worker = new Worker(workerEntry, {
      workerData: { ...options, html } satisfies ServerRenderRequest,
      // Packaged workers are ordinary ESM. Do not inherit caller loader or --input-type flags.
      execArgv: [],
    });
    worker.once("message", (reply: ServerRenderReply) => {
      replied = true;
      void worker.terminate();
      if ("result" in reply) resolve(reply.result);
      else reject(reply.error.diagnostic === undefined
        ? Object.assign(new Error(reply.error.message), { name: reply.error.name })
        : new HtmlDiagnosticError(reply.error.diagnostic));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!replied) reject(new Error(`Component rendering worker exited without a result (code ${code}).`));
    });
  });
}
