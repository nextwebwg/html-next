import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import ts from "typescript";

export interface StencilPropInventory {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly default?: string;
  readonly description: string;
}

export interface StencilEventInventory {
  readonly name: string;
  readonly detailType: string;
}

export interface StencilMethodInventory {
  readonly name: string;
  readonly returns: string;
}

export interface StencilSlotInventory {
  readonly name?: string;
  readonly dynamic: boolean;
}

export interface StencilComponentInventory {
  readonly tag: string;
  readonly interfaceName: string;
  readonly source: string;
  readonly registrationEntry: string;
  readonly description: string;
  readonly props: readonly StencilPropInventory[];
  readonly events: readonly StencilEventInventory[];
  readonly methods: readonly StencilMethodInventory[];
  readonly slots: readonly StencilSlotInventory[];
  readonly styles: readonly string[];
  readonly capabilities: readonly string[];
}

export interface StencilPackageInventory {
  readonly schemaVersion: 1;
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly exports: readonly string[];
  };
  readonly components: readonly StencilComponentInventory[];
}

export interface ExtractStencilOptions {
  readonly root: string;
  readonly typesFile?: string;
  readonly manifestFile?: string;
  readonly facadePackageFile?: string;
}

interface PublicShape {
  readonly description: string;
  readonly props: readonly StencilPropInventory[];
  readonly methods: readonly StencilMethodInventory[];
}

function nodeName(node: ts.NamedDeclaration): string | undefined {
  const name = node.name;
  if (name === undefined) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function cleanDocs(node: ts.Node, source: ts.SourceFile): { description: string; default?: string } {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  const raw = ranges.map((range) => source.text.slice(range.pos, range.end)).join("\n");
  const lines = raw.replace(/^\/\*\*?/, "").replace(/\*\/$/, "").split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").trim());
  const defaultLine = lines.find((line) => line.startsWith("@default "));
  return {
    description: lines.filter((line) => line !== "" && !line.startsWith("@default ")).join(" "),
    ...(defaultLine === undefined ? {} : { default: defaultLine.slice("@default ".length) }),
  };
}

function namespaceInterfaces(source: ts.SourceFile, namespace: string): Map<string, ts.InterfaceDeclaration> {
  const result = new Map<string, ts.InterfaceDeclaration>();
  const visit = (node: ts.Node, inside = false): void => {
    const inTarget = inside || (ts.isModuleDeclaration(node) && nodeName(node) === namespace);
    if (inTarget && ts.isInterfaceDeclaration(node)) result.set(node.name.text, node);
    node.forEachChild((child) => visit(child, inTarget));
  };
  visit(source);
  return result;
}

function publicShapes(source: ts.SourceFile): Map<string, PublicShape> {
  const result = new Map<string, PublicShape>();
  for (const [name, declaration] of namespaceInterfaces(source, "Components")) {
    const props: StencilPropInventory[] = [];
    const methods: StencilMethodInventory[] = [];
    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member) || member.type === undefined) continue;
      const memberName = nodeName(member);
      if (memberName === undefined) continue;
      const type = member.type.getText(source);
      const docs = cleanDocs(member, source);
      if (ts.isFunctionTypeNode(member.type)) {
        methods.push({ name: memberName, returns: member.type.type.getText(source) });
      } else {
        props.push({
          name: memberName,
          type,
          required: member.questionToken === undefined && docs.default === undefined,
          ...(docs.default === undefined ? {} : { default: docs.default }),
          description: docs.description,
        });
      }
    }
    result.set(name, {
      description: cleanDocs(declaration, source).description,
      props: Object.freeze(props.sort((left, right) => left.name.localeCompare(right.name))),
      methods: Object.freeze(methods.sort((left, right) => left.name.localeCompare(right.name))),
    });
  }
  return result;
}

function eventDetail(type: ts.TypeNode | undefined, source: ts.SourceFile): string {
  if (type === undefined || !ts.isFunctionTypeNode(type)) return "unknown";
  const parameter = type.parameters[0]?.type;
  if (parameter === undefined || !ts.isTypeReferenceNode(parameter) || parameter.typeArguments?.length !== 1) return "unknown";
  return parameter.typeArguments[0]!.getText(source);
}

function publicEvents(source: ts.SourceFile): Map<string, readonly StencilEventInventory[]> {
  const result = new Map<string, readonly StencilEventInventory[]>();
  for (const [name, declaration] of namespaceInterfaces(source, "LocalJSX")) {
    const events: StencilEventInventory[] = [];
    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member)) continue;
      const property = nodeName(member);
      if (property === undefined || !property.startsWith("on") || property.length < 3) continue;
      const authored = property.slice(2);
      events.push({
        name: `${authored[0]!.toLowerCase()}${authored.slice(1)}`,
        detailType: eventDetail(member.type, source),
      });
    }
    result.set(name, Object.freeze(events.sort((left, right) => left.name.localeCompare(right.name))));
  }
  return result;
}

function slotName(node: ts.JsxOpeningLikeElement, source: ts.SourceFile): StencilSlotInventory | undefined {
  if (node.tagName.getText(source) !== "slot") return undefined;
  const name = node.attributes.properties.find((attribute): attribute is ts.JsxAttribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "name"
  );
  if (name?.initializer === undefined) return { dynamic: false };
  if (ts.isStringLiteral(name.initializer)) return { name: name.initializer.text, dynamic: false };
  if (!ts.isJsxExpression(name.initializer) || name.initializer.expression === undefined) return { dynamic: true };
  const expression = name.initializer.expression;
  if (ts.isNoSubstitutionTemplateLiteral(expression) || ts.isStringLiteral(expression)) {
    return { name: expression.text, dynamic: false };
  }
  if (ts.isTemplateExpression(expression)) {
    const pattern = expression.head.text + expression.templateSpans
      .map((span) => `\${...}${span.literal.text}`).join("");
    return { name: pattern, dynamic: true };
  }
  return { name: expression.getText(source), dynamic: true };
}

function sourceFacts(path: string, root: string): Promise<{
  slots: readonly StencilSlotInventory[];
  styles: readonly string[];
  text: string;
}> {
  return readFile(path, "utf8").then((text) => {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const slots = new Map<string, StencilSlotInventory>();
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const slot = slotName(node, source);
        if (slot !== undefined) slots.set(`${slot.name ?? ""}:${slot.dynamic}`, slot);
      }
      node.forEachChild(visit);
    };
    visit(source);
    const styles = [...text.matchAll(/\bstyleUrls?\s*:\s*(?:\[\s*)?['"]([^'"]+)['"]/g)]
      .map((match) => relative(root, join(dirname(path), match[1]!)).split("\\").join("/"));
    return {
      slots: Object.freeze([...slots.values()].sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""))),
      styles: Object.freeze(styles.sort()),
      text,
    };
  });
}

function capabilities(
  tag: string,
  shape: PublicShape,
  events: readonly StencilEventInventory[],
  facts: Awaited<ReturnType<typeof sourceFacts>>,
): readonly string[] {
  const values = new Set<string>();
  if (shape.props.length > 0) values.add("props");
  if (events.length > 0) values.add("events");
  if (shape.methods.length > 0) values.add("methods");
  if (facts.slots.length > 0) values.add("slots");
  if (facts.slots.some((slot) => slot.dynamic)) values.add("data-derived-slots");
  if (facts.styles.length > 0) values.add("styles");
  if (shape.props.some((prop) => prop.name.startsWith("default") && shape.props.some((candidate) =>
    candidate.name === `${prop.name[7]?.toLowerCase() ?? ""}${prop.name.slice(8)}`
  ))) values.add("controlled-uncontrolled");
  if (shape.props.some((prop) => /(?:=>|Record<|readonly |\[\]|Config|Option|Issue|Node)/.test(prop.type))) values.add("property-input");
  if (/\b(?:input|select|textarea|form)\b/.test(facts.text) || shape.props.some((prop) =>
    ["name", "required", "value"].includes(prop.name)
  )) values.add("form-control");
  if (shape.methods.some((method) => /\bPromise\b/.test(method.returns)) || /\b(?:Promise|provider|AbortController|setTimeout)\b/.test(facts.text)) values.add("async");
  if (/\b(?:onKey|keydown|keyup|KeyboardEvent|focus\(|tabIndex)/i.test(facts.text)) values.add("keyboard-focus");
  if (/\b(?:dialog|popover|tooltip|context-menu|menu)\b/.test(tag) || /\b(?:openOverlay|createAnchoredSurface)\b/.test(facts.text)) values.add("overlay");
  if (/\b(?:stack|cluster|grid|sidebar|layout)\b/.test(tag)) values.add("layout");
  return Object.freeze([...values].sort());
}

export async function extractStencilInventory(options: ExtractStencilOptions): Promise<StencilPackageInventory> {
  const typesPath = options.typesFile ?? join(options.root, "packages/core/src/components.d.ts");
  const manifestPath = options.manifestFile ?? join(options.root, "packages/core/dist/collection/collection-manifest.json");
  const packagePath = options.facadePackageFile ?? join(options.root, "packages/looma/package.json");
  const [typesText, manifestText, packageText] = await Promise.all([
    readFile(typesPath, "utf8"), readFile(manifestPath, "utf8"), readFile(packagePath, "utf8"),
  ]);
  const source = ts.createSourceFile(typesPath, typesText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const shapes = publicShapes(source);
  const events = publicEvents(source);
  const manifest = JSON.parse(manifestText) as { entries: string[] };
  const facade = JSON.parse(packageText) as { name: string; version: string; exports: Record<string, unknown> };

  const components = await Promise.all(manifest.entries.map(async (registrationEntry) => {
    const tag = basename(registrationEntry, ".js");
    const interfaceName = tag.split("-").map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join("");
    const shape = shapes.get(interfaceName);
    if (shape === undefined) throw new Error(`Stencil types do not declare Components.${interfaceName} for <${tag}>.`);
    const componentEvents = events.get(interfaceName) ?? [];
    const sourcePath = join(options.root, "packages/core/src/components", tag, `${tag}.tsx`);
    const facts = await sourceFacts(sourcePath, options.root);
    return Object.freeze({
      tag,
      interfaceName,
      source: relative(options.root, sourcePath).split("\\").join("/"),
      registrationEntry,
      description: shape.description,
      props: shape.props,
      events: componentEvents,
      methods: shape.methods,
      slots: facts.slots,
      styles: facts.styles,
      capabilities: capabilities(tag, shape, componentEvents, facts),
    });
  }));

  return Object.freeze({
    schemaVersion: 1,
    package: Object.freeze({
      name: facade.name,
      version: facade.version,
      exports: Object.freeze(Object.keys(facade.exports).sort()),
    }),
    components: Object.freeze(components.sort((left, right) => left.tag.localeCompare(right.tag))),
  });
}
