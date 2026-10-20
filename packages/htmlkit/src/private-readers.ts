import { MessageChannel } from "node:worker_threads";
import type { BindingOperation } from "@nextwebwg/html-next/bindings";
import type { LoadContext, RouteParam } from "./types.js";
import { bindingsModule } from "./provider-preparation.js";
import { sendRead, type ReadCall, type ReadCodec, type ReadReply } from "./read-channel.js";

export interface ServerReadContext extends Omit<BindingOperation, "phase" | "captureInputs"> {
  readonly phase: "build" | "request";
  readonly url: URL;
  readonly base: string;
  readonly params: Readonly<Record<string, RouteParam>>;
  readonly request: Request;
  readonly cookies: ReadonlyMap<string, string>;
}
export interface ServerReader<I = unknown, V = unknown> { readonly load: (input: I, context: ServerReadContext) => V | PromiseLike<V> }
export type ServerReaders = Readonly<Record<string, ServerReader<any, any>>>;

/** Private readers are stateless request operations, not browser component constructors or hooks. */
export function serverReaders(module: unknown, origin: string): ServerReaders | undefined {
  const namespace = module as { readonly props?: unknown; readonly create?: unknown; readonly connect?: unknown };
  if (namespace.props === undefined) return undefined;
  if (namespace.create !== undefined) throw new TypeError(`${origin}: private readers export props with load functions; create belongs in the common or client module.`);
  if (namespace.connect !== undefined || namespace.props === null || typeof namespace.props !== "object" || Array.isArray(namespace.props)) {
    throw new TypeError(`${origin}: private props must contain reader objects and cannot export browser connect.`);
  }
  for (const [name, reader] of Object.entries(namespace.props)) {
    if (reader === null || typeof reader !== "object" || Object.keys(reader).some(key => key !== "load") || typeof (reader as ServerReader).load !== "function") {
      throw new TypeError(`${origin}: private reader ${name} supplies load; declare its selector and policy in the common module.`);
    }
  }
  return namespace.props as ServerReaders;
}

/** End the operation on abort even when a reader cannot cancel its external work. */
export async function readPrivate(reader: ServerReader, input: unknown, context: ServerReadContext): Promise<unknown> {
  const { signal } = context;
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return reader.load(input, context); }), cancelled]);
  } finally { signal.removeEventListener("abort", abort); }
}

export async function privateFailure(error: unknown): Promise<NonNullable<ReadReply["error"]>> {
  if (error instanceof Response && error.status >= 400) {
    try { return { name: "HttpError", message: await error.text(), status: error.status }; }
    catch { /* A consumed or failed response body cannot be made public. */ }
  }
  console.error(error);
  return { name: "Error", message: "Could not load component data.", status: 500 };
}

/** Parent-owned request/services stay outside the DOM worker and never enter structured-clone data. */
export async function privateReadBridge(readers: Readonly<Record<string, () => Promise<ServerReaders>>>, context: LoadContext, services: unknown) {
  context.signal.throwIfAborted();
  const codec = await import(bindingsModule) as ReadCodec;
  context.signal.throwIfAborted();
  const { port1, port2 } = new MessageChannel();
  const active = new Map<number, AbortController>();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true; context.signal.removeEventListener("abort", close);
    for (const controller of active.values()) controller.abort();
    active.clear(); port1.close();
  };
  context.signal.addEventListener("abort", close, { once: true });
  port1.once("close", close);
  port1.on("message", (message: ReadCall | { readonly kind: "cancel"; readonly id: number }) => {
    if (message.kind === "cancel") { active.get(message.id)?.abort(); active.delete(message.id); return; }
    if (closed || active.has(message.id)) return;
    const controller = new AbortController(); active.set(message.id, controller);
    const reply = (result: Omit<ReadReply, "id">): void => { if (!closed && active.get(message.id) === controller) sendRead(port1, { id: message.id, ...result }); };
    void (async () => {
      try {
        const module = await readers[message.tag]?.();
        const reader = module === undefined || !Object.hasOwn(module, message.name) ? undefined : module[message.name];
        if (reader === undefined) throw new Error("Unknown private reader.");
        const operation: ServerReadContext = {
          phase: context.phase === "prerender" ? "build" : "request", url: new URL(context.url), base: context.base, params: context.params,
          signal: controller.signal, sample: codec.decodeHydrationValue(message.sample), services, fetch: context.fetch,
          get request() { return context.request; }, get cookies() { return context.cookies; },
        };
        operation.signal.throwIfAborted();
        const value = await readPrivate(reader, codec.decodeHydrationValue(message.input), operation);
        if (!controller.signal.aborted) reply({ value: codec.encodeHydrationValue(value) });
      } catch (error) {
        if (!controller.signal.aborted && !closed) reply({ error: await privateFailure(error) });
      } finally { if (active.get(message.id) === controller) active.delete(message.id); }
    })();
  });
  return { port: port2, close };
}
