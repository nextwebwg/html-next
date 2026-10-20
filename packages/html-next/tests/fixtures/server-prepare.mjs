import { bindModule } from "../../src/bindings.ts";

export async function prepare({ document, host, flush, signal, data, port }) {
  port?.postMessage({ event: "start", query: data.query });
  if (data.wait) await new Promise(() => {});
  if (data.fail) throw new Error("Preparation refused");
  const module = bindModule({
    props: { product: { input: () => data.query, async load(query) {
      if (port === undefined) return data.product;
      const answer = new Promise(resolve => port.once("message", resolve));
      port.postMessage({ event: "read", query });
      return await answer;
    } } },
    connect() { throw new Error("Browser connect ran during SSR"); },
  });
  const prepared = await module.prepare(host(document.querySelector("#subject")), { phase: "request", signal, source: "preparation-test" });
  await flush();
  document.querySelector("#subject").dataset.prepared = prepared.snapshot().source;
  return async () => {
    prepared.dispose();
    await Promise.resolve();
    port?.postMessage({ event: "cleanup", aborted: signal.aborted });
    if (data.cleanupFail) throw new Error("Cleanup refused");
  };
}
