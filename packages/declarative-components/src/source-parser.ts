import { parseFragment, type ParserError } from "parse5";

import { fail } from "./diagnostics.js";
import { parseComponentNodes } from "./parser.js";
import { getDomInterface, resolveDomProperty } from "./platform.js";
import type { ComponentDefinition } from "./template.js";

// The HTML Standard parses `<select>` content in the "in body" insertion mode, so a `<slot>` or
// other element inside a select is kept (the customizable-select parser change). parse5 still
// implements the retired "in select" mode, which drops it. Until parse5 follows the standard, select
// tags are parsed under a same-length placeholder name (so source locations stay exact) and renamed
// back. The placeholder never leaves the parser.
const SELECT_PLACEHOLDER = "s-lect";
const SELECT_TAG = /<(\/?)select(?=[\s/>])/gi;

type ParsedNode = { nodeName: string; tagName?: string; childNodes?: ParsedNode[]; content?: ParsedNode };

function restoreSelect(node: ParsedNode): void {
  if (node.nodeName === SELECT_PLACEHOLDER) {
    node.nodeName = "select";
    node.tagName = "select";
  }
  for (const child of node.childNodes ?? []) restoreSelect(child);
  if (node.content !== undefined) restoreSelect(node.content);
}

/** Parses a component definition from source text for build tools and network loaders. */
export function parseComponent(
  sourceText: string,
  source = "<source>",
): ComponentDefinition {
  const parserErrors: ParserError[] = [];
  const fragment = parseFragment(sourceText.replace(SELECT_TAG, `<$1${SELECT_PLACEHOLDER}`), {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parserErrors.push(error),
  });
  if (parserErrors.length > 0) {
    fail("HS005", `HTML parse error: ${parserErrors[0]!.code}.`, source);
  }
  restoreSelect(fragment as unknown as ParsedNode);
  return parseComponentNodes(fragment.childNodes, source, {
    isNativeElement: (name) => getDomInterface(name) !== undefined,
    resolveDomProperty,
  });
}
