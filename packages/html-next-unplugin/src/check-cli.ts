#!/usr/bin/env node

import { checkHtmlNext, formatCheckDiagnostic, type HtmlNextCheckOptions } from "./index.js";

const usage = "Usage: html-next-check [--target native|vue|react|svelte] [--mode application|library] [--json] [--no-color] [--public-root-url <url>] [--external-custom-element <tag>] [--extension <name>] [component.html|directory|glob]...";

try {
  const args = process.argv.slice(2);
  let target: "native" | "vue" | "react" | "svelte" = "native";
  let mode: "application" | "library" = "application";
  let json = false;
  let hyperlinks = process.env.NO_COLOR === undefined;
  let publicRootURL: string | undefined;
  const entries: string[] = [];
  const dynamicBoundaries: { tag: string; strategy: "external-custom-element" }[] = [];
  const extensions: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help") {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }
    if (argument === "--") {
      entries.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith("--")) {
      entries.push(argument);
      continue;
    }
    if (seen.has(argument) && argument !== "--external-custom-element" && argument !== "--extension") throw new Error(usage);
    seen.add(argument);
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--no-color") {
      hyperlinks = false;
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(usage);
    if (argument === "--target" && (value === "native" || value === "vue" || value === "react" || value === "svelte")) target = value;
    else if (argument === "--mode" && (value === "application" || value === "library")) mode = value;
    else if (argument === "--public-root-url") publicRootURL = value;
    else if (argument === "--external-custom-element") dynamicBoundaries.push({ tag: value, strategy: "external-custom-element" });
    else if (argument === "--extension") extensions.push(value);
    else throw new Error(usage);
  }
  if ((target === "native" && publicRootURL !== undefined) || (target !== "native" && (dynamicBoundaries.length > 0 || extensions.length > 0))) throw new Error(usage);
  const options: HtmlNextCheckOptions = target === "native"
    ? { target, mode, entries, dynamicBoundaries, ...(extensions.length === 0 ? {} : { extensions }) }
    : { target, mode, entries, ...(publicRootURL === undefined ? {} : { publicRootURL }) };
  const diagnostics = await checkHtmlNext(options);
  if (json) process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
  else for (const diagnostic of diagnostics) {
    process.stderr.write(`${formatCheckDiagnostic(diagnostic, { hyperlinks })}\n`);
  }
  process.exitCode = diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
