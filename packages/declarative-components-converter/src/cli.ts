#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { convertComponents, type ConversionGraph, type FrameworkTarget } from "./index.js";

function usage(): string {
  return "Usage: html-next-convert <react|vue|svelte> <component.html...> --mode <application|library> --out-dir <directory>";
}

async function main(argv: readonly string[]): Promise<void> {
  const target = argv[0] as FrameworkTarget | undefined;
  const modeIndex = argv.indexOf("--mode");
  const mode = argv[modeIndex + 1] as ConversionGraph | undefined;
  const outIndex = argv.indexOf("--out-dir");
  const outDirectory = argv[outIndex + 1];
  if (
    target === undefined || !(["react", "vue", "svelte"] as const).includes(target) ||
    mode === undefined || !(["application", "library"] as const).includes(mode) ||
    modeIndex < 2 || outIndex !== modeIndex + 2 || outDirectory === undefined ||
    outIndex !== argv.length - 2
  ) throw new Error(usage());
  await convertComponents({ mode, entries: argv.slice(1, modeIndex), target, outDirectory });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
