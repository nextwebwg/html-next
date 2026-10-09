#!/usr/bin/env node

import { convertComponents, type ConversionGraph, type FrameworkTarget } from "./index.js";

function usage(): string {
  return "Usage: html-next-convert <vue|react|svelte> <component.html|directory|glob>... --mode <application|library> --out-dir <directory> [--public-root-url <url>]";
}

async function main(argv: readonly string[]): Promise<void> {
  const target = argv[0] as FrameworkTarget | undefined;
  const modeIndex = argv.indexOf("--mode");
  const mode = argv[modeIndex + 1] as ConversionGraph | undefined;
  const outIndex = argv.indexOf("--out-dir");
  const outDirectory = argv[outIndex + 1];
  const publicRootIndex = argv.indexOf("--public-root-url");
  const publicRootURL = publicRootIndex < 0 ? undefined : argv[publicRootIndex + 1];
  if (
    target === undefined || !(["vue", "react", "svelte"] as const).includes(target) ||
    mode === undefined || !(["application", "library"] as const).includes(mode) ||
    modeIndex < 2 || outIndex !== modeIndex + 2 || outDirectory === undefined ||
    (publicRootIndex < 0 ? outIndex !== argv.length - 2 : publicRootIndex !== outIndex + 2 || publicRootIndex !== argv.length - 2 || publicRootURL === undefined)
  ) throw new Error(usage());
  await convertComponents({ mode, entries: argv.slice(1, modeIndex), target, outDirectory, ...(publicRootURL === undefined ? {} : { publicRootURL }) });
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
