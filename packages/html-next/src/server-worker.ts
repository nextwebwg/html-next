import { parentPort, workerData } from "node:worker_threads";

import { JSDOM, VirtualConsole } from "jsdom";
import "@formatjs/intl-durationformat/polyfill.js";

import { parseBrowserProjectedSlot } from "./browser-source.js";
import { compileComponentStylesForBuild } from "./component-styles-build.js";
import { HtmlDiagnosticError, fail } from "./diagnostics.js";
import {
  getComponentHost,
  installProjectedSlotParser,
  lowerDocument,
  registerComponentDefinitions,
  serializeRenderedForm,
} from "./runtime.js";
import type { ServerRenderReply, ServerRenderRequest } from "./server.js";

const request = workerData as ServerRenderRequest;
let dom: JSDOM | undefined;
try {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: request.url ?? "https://html-next.invalid/",
    // Page scripts remain inert. Component controllers connect at browser hydration.
    virtualConsole: new VirtualConsole(),
  });
  const view = dom.window;
  for (const name of [
    "Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement",
    "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver",
    "Event", "CustomEvent", "KeyboardEvent", "MouseEvent",
  ]) Object.defineProperty(globalThis, name, { value: view[name as keyof typeof view], configurable: true });
  const document = view.document;
  document.body.innerHTML = request.html;
  installProjectedSlotParser(parseBrowserProjectedSlot);
  registerComponentDefinitions(request.definitions, document, compileComponentStylesForBuild);
  lowerDocument(document, { connect: false });
  for (const [selector, state] of Object.entries(request.state ?? {})) {
    const elements = document.querySelectorAll(selector);
    if (elements.length === 0) fail("HR010", `Initial state selector \`${selector}\` matches no component.`);
    for (const element of elements) {
      const host = getComponentHost(element);
      if (host === undefined) fail("HR010", `Initial state selector \`${selector}\` does not identify a component.`);
      for (const [name, value] of Object.entries(state)) host.state[name] = value;
    }
  }
  // Drain the shared runtime's microtask updates, including nested structural changes.
  await new Promise<void>((resolve) => setImmediate(resolve));
  lowerDocument(document, { connect: false });
  const result = {
    html: serializeRenderedForm(document.body),
    css: Array.from(document.head.querySelectorAll("style"), (style) => style.textContent).join("\n"),
  };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no origin argument.
  parentPort!.postMessage({ result } satisfies ServerRenderReply);
} catch (error) {
  // oxlint-disable unicorn/require-post-message-target-origin -- Node MessagePort has no origin argument.
  parentPort!.postMessage({ error: {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof HtmlDiagnosticError ? { diagnostic: error.diagnostic } : {}),
  } } satisfies ServerRenderReply);
  // oxlint-enable unicorn/require-post-message-target-origin
} finally {
  dom?.window.close();
  parentPort!.close();
}
