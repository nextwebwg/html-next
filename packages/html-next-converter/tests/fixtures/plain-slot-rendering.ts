import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";

import { plainSlotFiles, plainSlotInvocations, repeatedPlainSource } from "../../../html-next/tests/fixtures/plain-slot-ownership.js";
import { convertComponents } from "../../src/index.js";

export async function plainSlotRendering(target: "react" | "preact"): Promise<{ directory: string; html: string; entry: string }> {
  const directory = await mkdtemp(join(tmpdir(), `html-next-${target}-plain-server-`));
  try {
    const sources = { ...plainSlotFiles, "repeated.html": repeatedPlainSource,
      "page.html": `<template component="x-ssr-plain"><main>${plainSlotInvocations}<x-repeat-page></x-repeat-page></main></template>` };
    for (const [name, source] of Object.entries(sources)) await writeFile(join(directory, name), source);
    const output = join(directory, "out");
    const manifest = await convertComponents({ mode: "library", target, root: directory, outDirectory: output, entries: ["*.html"] });
    const entry = join(output, manifest.output.entry);
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs",
      jsx: "automatic", ...(target === "preact" ? { jsxImportSource: "preact" } : {}), packages: "external", loader: { ".css": "empty" },
      nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
    const module = { exports: {} as Record<string, ComponentType> };
    const require = createRequire(import.meta.url);
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(require, module, module.exports);
    const node = target === "react" ? createElement(module.exports.XSsrPlain!) : require("preact/compat").createElement(module.exports.XSsrPlain!, {});
    const html: string = target === "react" ? renderToString(node) : require("preact-render-to-string")(node);
    return { directory, html, entry };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
