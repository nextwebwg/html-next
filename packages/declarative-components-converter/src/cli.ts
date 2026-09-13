#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { convertComponents, type FrameworkTarget } from "./index.js";

function usage(): string {
  return "Usage: html-next-convert <react|vue|svelte> <component.html...> --out-dir <directory>";
}

async function main(argv: readonly string[]): Promise<void> {
  const target = argv[0] as FrameworkTarget | undefined;
  const outIndex = argv.indexOf("--out-dir");
  const outDirectory = argv[outIndex + 1];
  if (
    target === undefined || !(["react", "vue", "svelte"] as const).includes(target) ||
    outIndex < 2 || outDirectory === undefined || outIndex !== argv.length - 2
  ) throw new Error(usage());
  await convertComponents({ entries: argv.slice(1, outIndex), target, outDirectory });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
