import { threadId } from "node:worker_threads";

export async function prepare({ document, data, port }) {
  const released = new Promise(resolve => port.once("message", resolve));
  port.postMessage({ id: data.id, threadId });
  await released;
  document.body.append(document.createTextNode(data.id));
}
