/**
 * The live delivery's runtime entry: the general runtime plus the parser that reads definitions
 * authored in the document.
 *
 * A build-time graph imports `runtime.js` and registers already parsed definitions, so it never
 * pays for the parser. Anything that discovers `<template component>` in a live page imports this
 * module instead.
 *
 * The parser is installed inside these functions rather than when the module loads, because the
 * package declares `sideEffects: false` and a bundler is free to drop a top-level call.
 */
import { parseBrowserComponent } from "./browser-source.js";
import {
  installInlineDefinitionParser,
  lowerDocument as lowerDocumentWithoutParser,
  observeDocument as observeDocumentWithoutParser,
  type DocumentObservationOptions,
} from "./runtime.js";

/** Lowers the definitions and instances the document already contains. */
export function lowerDocument(root: Document = document): number {
  installInlineDefinitionParser(parseBrowserComponent);
  return lowerDocumentWithoutParser(root);
}

/** Lowers the document and keeps observing it for later definitions and instances. */
export function observeDocument(
  root: Document = document,
  options: DocumentObservationOptions = {},
): () => void {
  installInlineDefinitionParser(parseBrowserComponent);
  return observeDocumentWithoutParser(root, options);
}

export * from "./runtime.js";
