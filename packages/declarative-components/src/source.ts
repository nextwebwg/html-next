import { parseComponent } from "./source-parser.js";
import type { ComponentDefinition } from "./template.js";

/** Parse an authored HTML source unit into the canonical normalized component AST. */
export function parseSourceComponent(
  sourceText: string,
  source = "<source>",
): ComponentDefinition {
  return parseComponent(sourceText, source);
}
