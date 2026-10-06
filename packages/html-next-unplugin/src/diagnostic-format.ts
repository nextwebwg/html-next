import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { HtmlNextCheckDiagnostic } from "./index.js";

export interface CheckDiagnosticFormatOptions {
  readonly root?: string;
  /** OSC 8 links open the authored location in VS Code. Default: true. */
  readonly hyperlinks?: boolean;
}

function singleLine(text: string): string {
  // Descriptions and paths must not inject terminal control sequences or extra rows.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, " ");
}

/** A compact Jess-style diagnostic row, with no source excerpt or trailing newline. */
export function formatCheckDiagnostic(diagnostic: HtmlNextCheckDiagnostic, options: CheckDiagnosticFormatOptions = {}): string {
  const prefix = `${diagnostic.source === undefined ? "" : `${diagnostic.source}: `}${diagnostic.code}: `;
  const description = diagnostic.message.startsWith(prefix) ? diagnostic.message.slice(prefix.length) : diagnostic.message;
  const row = `${diagnostic.severity} ${diagnostic.code}  ${singleLine(description)}`;
  if (diagnostic.source === undefined) return row;
  const root = resolve(options.root ?? process.cwd());
  const source = diagnostic.source;
  const file = source.startsWith("file:") ? fileURLToPath(source)
    : source.startsWith("<") || (!isAbsolute(source) && /^[a-z][a-z\d+.-]*:/i.test(source)) ? undefined
    : resolve(root, source);
  const suffix = diagnostic.line === undefined || diagnostic.column === undefined ? "" : `:${diagnostic.line}:${diagnostic.column}`;
  const label = singleLine(`${file === undefined ? source : relative(root, file)}${suffix}`);
  const uri = file === undefined ? undefined : new URL(pathToFileURL(file).href);
  const location = uri !== undefined && options.hyperlinks !== false
    ? `\x1b]8;;vscode://file${uri.hostname === "" ? "" : `//${uri.hostname}`}${uri.pathname}${suffix}\x1b\\${label}\x1b]8;;\x1b\\`
    : label;
  return `${row}  ·  ${location}`;
}
