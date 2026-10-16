import { hoistStylesheetNamespaces } from "./stylesheet-namespaces.js";
import { parentPort } from "node:worker_threads";

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
  renderServerHead,
  serializeRenderedForm,
} from "./runtime.js";
import { HEAD_MARKER } from "./head.js";
import type { RenderedComponents, ServerRenderReply, ServerRenderRequest } from "./server.js";

// The browser constructors the runtime reads as globals, pointed at each render's own window.
const globals = [
  "Node", "Element", "HTMLElement", "Text", "Comment", "HTMLTemplateElement", "HTMLInputElement",
  "HTMLTextAreaElement", "HTMLSelectElement", "HTMLOptionElement", "HTMLFormElement", "MutationObserver",
  "Event", "CustomEvent", "KeyboardEvent", "MouseEvent",
] as const;
const original = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
installProjectedSlotParser(parseBrowserProjectedSlot);

/**
 * One render in its own JSDOM document and window. The component registry belongs to the document,
 * and component instances to its elements, so all of them go with the window. The browser globals
 * are restored afterwards, so nothing a render installs reaches the next one.
 */
async function render(request: ServerRenderRequest): Promise<RenderedComponents> {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: request.url ?? "https://html-next.invalid/",
    // Page scripts remain inert. Component controllers connect at browser hydration.
    virtualConsole: new VirtualConsole(),
  });
  try {
    const view = dom.window;
    for (const name of globals) Object.defineProperty(globalThis, name, { value: view[name], configurable: true });
    const document = view.document;
    // The application document's own head: reconciliation starts from it (H1).
    document.head.innerHTML = request.head ?? "";
    const authored = new Set<Element>(Array.from(document.head.children));
    document.body.innerHTML = request.html;
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
    // Drain the shared runtime's microtask updates, including nested structural changes, until a
    // pass lowers nothing: a component in a row those updates render takes its props in the next drain.
    let pass = 0;
    do {
      if (++pass > 32) fail("HR008", "Component invocations nested deeper than the lowering limit.");
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (lowerDocument(document, { connect: false }) > 0);
    renderServerHead(document);
    return {
      html: serializeRenderedForm(document.body),
      head: Array.from(document.head.children, (element) => authored.has(element) || element.hasAttribute(HEAD_MARKER) ? element.outerHTML : "").join(""),
      css: hoistStylesheetNamespaces(Array.from(document.head.querySelectorAll("style"), (style) => style.textContent).join("\n")),
      styleOwnership: Object.assign({}, ...Array.from(document.head.querySelectorAll("style[data-html-next-component-styles]"),
        (style) => JSON.parse(style.getAttribute("data-html-next-style-states") ?? "{}"))) as Record<string, string[]>,
    };
  } finally {
    dom.window.close();
    for (const [name, descriptor] of original) {
      if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

// The pool sends one render at a time and waits for its reply.
parentPort!.on("message", async (request: ServerRenderRequest) => {
  let reply: ServerRenderReply;
  try { reply = { result: await render(request) }; }
  catch (error) {
    reply = { error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof HtmlDiagnosticError ? { diagnostic: error.diagnostic } : {}),
    } };
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no origin argument.
  parentPort!.postMessage(reply);
});
