import type { MessagePort } from "node:worker_threads";
import type { BindingOperation, HydrationValue } from "@nextwebwg/html-next/bindings";

export interface ReadCodec { encodeHydrationValue(value: unknown): HydrationValue; decodeHydrationValue(value: unknown): unknown }
export interface ReadCall { readonly kind: "read"; readonly id: number; readonly tag: string; readonly name: string; readonly input: HydrationValue; readonly sample: HydrationValue }
export interface ReadReply { readonly id: number; readonly value?: HydrationValue; readonly error?: { readonly name: string; readonly message: string; readonly status?: number } }
export function sendRead(port: MessagePort, message: unknown): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Native Node MessagePort has no origin.
  port.postMessage(message);
}

/** One render's existing transferred port; no application-global request or value cache. */
export function readChannel(port: MessagePort, codec: ReadCodec) {
  let next = 0; let closed = false;
  const pending = new Map<number, { accept(reply: ReadReply): void; reject(error: unknown): void }>();
  const receive = (reply: ReadReply): void => { pending.get(reply.id)?.accept(reply); };
  const close = (): void => {
    if (closed) return;
    closed = true;
    port.off("message", receive);
    for (const request of pending.values()) request.reject(new DOMException("The render's private read channel closed.", "AbortError"));
    pending.clear();
  };
  port.on("message", receive); port.once("close", close);
  return {
    read(tag: string, name: string, input: unknown, operation: BindingOperation): Promise<unknown> {
      if (closed || operation.signal.aborted) return Promise.reject(operation.signal.reason ?? new DOMException("Private reads are closed.", "AbortError"));
      const id = next++;
      return new Promise((resolve, reject) => {
        const done = (error?: unknown, reply?: ReadReply): void => {
          pending.delete(id); operation.signal.removeEventListener("abort", abort);
          if (error !== undefined) reject(error);
          else if (reply?.error !== undefined) reject(Object.assign(new Error(reply.error.message), { name: reply.error.name }));
          else { try { resolve(codec.decodeHydrationValue(reply!.value)); } catch (error) { reject(error); } }
        };
        const abort = (): void => {
          try { if (!closed) sendRead(port, { kind: "cancel", id }); } catch { /* A closed peer needs no cancellation frame. */ }
          done(operation.signal.reason ?? new DOMException("Private read aborted.", "AbortError"));
        };
        pending.set(id, { accept: reply => done(undefined, reply), reject: error => done(error) });
        operation.signal.addEventListener("abort", abort, { once: true });
        try { sendRead(port, { kind: "read", id, tag, name, input: codec.encodeHydrationValue(input), sample: codec.encodeHydrationValue(operation.sample) } satisfies ReadCall); }
        catch (error) { done(error); }
      });
    },
    close,
  };
}
