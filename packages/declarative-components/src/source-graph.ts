import {
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";

import { fail } from "./diagnostics.js";
import {
  buildComponentGraph as buildParsedComponentGraph,
  type BuildGraphOptions,
  type ComponentGraph,
  type ParsedComponentResource,
} from "./graph.js";
import { parseComponent } from "./source-parser.js";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type Template = DefaultTreeAdapterTypes.Template;

function isElement(node: ChildNode): node is Element {
  return "tagName" in node;
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value;
}

function significant(nodes: readonly ChildNode[]): ChildNode[] {
  return nodes.filter((node) => {
    if (node.nodeName === "#comment") return false;
    if (node.nodeName === "#text" && "value" in node) return node.value.trim() !== "";
    return true;
  });
}

/** Separates resource-level dependency links from the one inert component carrier. */
export function parseComponentResource(sourceText: string, source: string): ParsedComponentResource {
  const parserErrors: ParserError[] = [];
  const fragment = parseFragment(sourceText, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parserErrors.push(error),
  });
  if (parserErrors.length > 0) {
    fail("HS005", `HTML parse error: ${parserErrors[0]!.code}.`, source);
  }
  const nodes = significant(fragment.childNodes);
  const templates = nodes.filter(
    (node): node is Template => isElement(node) && node.tagName === "template" && attr(node, "component") !== undefined,
  );
  if (templates.length !== 1) {
    fail("HS001", "A component resource must contain exactly one <template component>.", source);
  }
  const dependencies: string[] = [];
  for (const node of nodes) {
    if (node === templates[0]) continue;
    if (!isElement(node) || node.tagName !== "link" || attr(node, "rel") !== "component") {
      fail("HT009", "A component resource may contain only dependency links and one inert carrier.", source);
    }
    const href = attr(node, "href");
    if (href === undefined || href.trim() === "") {
      fail("HL006", "A component dependency link requires a non-empty `href`.", source);
    }
    dependencies.push(href);
  }
  const location = templates[0]!.sourceCodeLocation;
  if (location == null || !("startOffset" in location) || !("endOffset" in location)) {
    fail("HS005", "The component carrier has no stable source range.", source);
  }
  return Object.freeze({
    definition: parseComponent(sourceText.slice(location.startOffset, location.endOffset), source),
    dependencies: Object.freeze(dependencies),
  });
}

export function buildComponentGraph(
  rootSpecifiers: readonly string[],
  options: Omit<BuildGraphOptions, "parseComponentResource">,
): Promise<ComponentGraph> {
  return buildParsedComponentGraph(rootSpecifiers, { ...options, parseComponentResource });
}
