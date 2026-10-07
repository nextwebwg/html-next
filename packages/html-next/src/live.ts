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
import { parseBrowserComponent, parseBrowserProjectedSlot } from "./browser-source.js";
import {
  installInlineDefinitionParser,
  installProjectedSlotParser,
  lowerDocument as lowerDocumentWithoutParser,
  observeDocument as observeDocumentWithoutParser,
  type DocumentObservationOptions,
  type DocumentRenderingOptions,
} from "./runtime.js";

/** Lowers the definitions and instances the document already contains. */
export function lowerDocument(root: Document = document, options: DocumentRenderingOptions = {}): number {
  installInlineDefinitionParser(parseBrowserComponent);
  installProjectedSlotParser(parseBrowserProjectedSlot);
  return lowerDocumentWithoutParser(root, options);
}

/** Lowers the document and keeps observing it for later definitions and instances. */
export function observeDocument(
  root: Document = document,
  options: DocumentObservationOptions = {},
): () => void {
  installInlineDefinitionParser(parseBrowserComponent);
  installProjectedSlotParser(parseBrowserProjectedSlot);
  return observeDocumentWithoutParser(root, options);
}

export * from "./runtime.js";
