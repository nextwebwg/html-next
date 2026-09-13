import { parseFragment, type ParserError } from "parse5";

import { fail } from "./diagnostics.js";
import { parseComponentNodes } from "./parser.js";
import type { ComponentDefinition } from "./template.js";

/** Parses a component definition from source text for build tools and network loaders. */
export function parseComponent(
  sourceText: string,
  source = "<source>",
): ComponentDefinition {
  const parserErrors: ParserError[] = [];
  const fragment = parseFragment(sourceText, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parserErrors.push(error),
  });
  if (parserErrors.length > 0) {
    fail("HS005", `HTML parse error: ${parserErrors[0]!.code}.`, source);
  }
  return parseComponentNodes(fragment.childNodes, source);
}
