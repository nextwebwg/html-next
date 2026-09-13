import {
  documentComponentRoots,
  loadBrowserComponents,
  loadDocumentComponents,
  startBrowserComponents,
  type BrowserLoaderOptions,
  type StartedBrowserComponents,
} from "./browser-loader.js";

const browserRuntimeKey = Symbol.for("@nextwebwg/declarative-components/browser");

interface BrowserRuntimeState {
  readonly ready: Promise<StartedBrowserComponents>;
}

type BrowserGlobal = typeof globalThis & {
  [browserRuntimeKey]?: BrowserRuntimeState;
  HTMLNext?: Readonly<{
    ready: Promise<StartedBrowserComponents>;
    documentComponentRoots: typeof documentComponentRoots;
    loadBrowserComponents: typeof loadBrowserComponents;
    loadDocumentComponents: typeof loadDocumentComponents;
    startBrowserComponents: typeof startBrowserComponents;
  }>;
};

const browserGlobal = globalThis as BrowserGlobal;
const state = browserGlobal[browserRuntimeKey] ?? Object.freeze({
  ready: startBrowserComponents(),
});
browserGlobal[browserRuntimeKey] = state;

export const ready = state.ready;

export {
  documentComponentRoots,
  loadBrowserComponents,
  loadDocumentComponents,
  startBrowserComponents,
};
export type { BrowserLoaderOptions, StartedBrowserComponents };

browserGlobal.HTMLNext ??= Object.freeze({
  ready,
  documentComponentRoots,
  loadBrowserComponents,
  loadDocumentComponents,
  startBrowserComponents,
});
