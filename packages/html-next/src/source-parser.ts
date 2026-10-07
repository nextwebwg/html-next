import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import { parseComponentNodes } from "./parser.js";
import { getDomInterface, resolveDomProperty } from "./platform.js";
import { fail, recoverDiagnostic, type HtmlDiagnostic, type DiagnosticLocation } from "./diagnostics.js";
import { isIgnoredResourceMetadata } from "./resource-metadata.js";
import type { DiagnosedComponentResource, ParsedComponentResource } from "./graph.js";
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

function parseSource(sourceText: string): DefaultTreeAdapterTypes.DocumentFragment {
  const fragment = parseFragment(sourceText.replace(SELECT_TAG, `<$1${SELECT_PLACEHOLDER}`), {
    sourceCodeLocationInfo: true,
  });
  restoreSelect(fragment as unknown as ParsedNode);
  return fragment;
}

const platform = { isNativeElement: (name: string) => getDomInterface(name) !== undefined, resolveDomProperty };

function nodeLocation(node: DefaultTreeAdapterTypes.ChildNode): DiagnosticLocation | undefined {
  const location = node.sourceCodeLocation;
  return location == null ? undefined : { line: location.startLine, column: location.startCol };
}

/** Parses one component carrier. Resources can contain several carriers. */
export function parseComponent(sourceText: string, source = "<source>"): ComponentDefinition {
  return parseComponentNodes(parseSource(sourceText).childNodes, source, platform);
}

/** Parses all inert component carriers and resource-level dependency links in one HTML file. */
export function parseComponentResource(sourceText: string, source: string): ParsedComponentResource {
  return finishResource(readComponentResource(sourceText, source), source);
}

/** Check-only recovery; invalid resources are never returned as usable semantic graphs. */
export function parseComponentResourceForCheck(sourceText: string, source: string): DiagnosedComponentResource {
  const diagnostics: HtmlDiagnostic[] = [];
  const resource = readComponentResource(sourceText, source, (diagnostic) => diagnostics.push(diagnostic));
  const valid = (): boolean => diagnostics.every((diagnostic) => diagnostic.severity === "warning");
  if (valid()) {
    try { finishResource(resource, source); }
    catch (error) { recoverDiagnostic(error, (diagnostic) => diagnostics.push(diagnostic)); }
  }
  return { definitions: valid() ? resource.definitions : [], dependencies: resource.dependencies, diagnostics };
}

function finishResource(resource: Pick<ParsedComponentResource, "definitions" | "dependencies">, source: string): ParsedComponentResource {
  if (resource.definitions.length === 0) fail("HS001", "A component resource requires at least one <template component>.", source);
  return Object.freeze({ definition: resource.definitions[0]!, ...resource });
}

function readComponentResource(sourceText: string, source: string, onDiagnostic?: (diagnostic: HtmlDiagnostic) => void): Pick<ParsedComponentResource, "definitions" | "dependencies"> {
  const definitions: ComponentDefinition[] = [];
  const dependencies: string[] = [];
  for (const node of parseSource(sourceText).childNodes) {
    if (node.nodeName === "#comment" || (node.nodeName === "#text" && "value" in node && node.value.trim() === "")) continue;
    try {
      if ("tagName" in node && node.tagName === "template" && node.attrs.some((attr) => attr.name === "component")) {
        definitions.push(parseComponentNodes([node], source, onDiagnostic === undefined ? platform : { ...platform, onDiagnostic }));
      } else if ("tagName" in node && node.tagName === "link" && node.attrs.some((attr) => attr.name === "rel" && attr.value === "component")) {
        const href = node.attrs.find((attr) => attr.name === "href")?.value;
        if (href === undefined || href.trim() === "") fail("HL006", "A component dependency link requires a non-empty `href`.", source, nodeLocation(node));
        dependencies.push(href);
      } else if ("tagName" in node && isIgnoredResourceMetadata(node.tagName, node.attrs)) {
        continue;
      } else {
        fail("HT009", "A component resource may contain only dependency links, inert component carriers, and non-policy-changing metadata.", source, nodeLocation(node));
      }
    } catch (error) { recoverDiagnostic(error, onDiagnostic); }
  }
  return { definitions: Object.freeze(definitions), dependencies: Object.freeze(dependencies) };
}
