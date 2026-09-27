// The live browser entry. Importing it is the whole setup: it starts once per realm, loads the
// components the document links, and keeps rendering instances as they are added or removed.
import { startBrowserComponents, type StartedBrowserComponents } from "./browser-loader.js";

const browserRuntimeKey = Symbol.for("@nextwebwg/html-next/browser");

interface BrowserRuntimeState {
  readonly ready: Promise<StartedBrowserComponents>;
}

type BrowserGlobal = typeof globalThis & {
  [browserRuntimeKey]?: BrowserRuntimeState;
  HTMLNext?: Readonly<{ ready: Promise<StartedBrowserComponents> }>;
};

const browserGlobal = globalThis as BrowserGlobal;
const state = browserGlobal[browserRuntimeKey] ?? Object.freeze({
  ready: startBrowserComponents(),
});
browserGlobal[browserRuntimeKey] = state;

/** Resolves once the components the document links have loaded. */
export const ready = state.ready;
export type { StartedBrowserComponents };

browserGlobal.HTMLNext ??= Object.freeze({ ready });
