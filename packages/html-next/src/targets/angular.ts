/** Standalone Angular components on their declared native hosts. Root delegation is composed at build time. */
import postcss from "postcss";
import { kebabCase, componentName as pascalCase } from "../names.js";
import { parseDuration } from "../duration.js";
import { fail } from "../diagnostics.js";
import type { CompiledExpression } from "../expression.js";
import { componentStateNames, compileComponentGraphStylesForBuild, VUE_ROOT_ATTRIBUTE } from "../component-styles-build.js";
import { stateAttribute } from "../component-styles.js";
import type { ComponentDefinition, ElementNode, HandlerDeclaration, TemplateNode } from "../template.js";
import { elementMatchRoot, iteratedRefNames } from "../template.js";
import { declarationTypeNode, normalizeType, parseTypedValue, typeScriptType, type TypeNode } from "../type-system.js";
import { headEntriesSource, headScriptsSource, headHelperArtifact } from "./head-target.js";
import { targetComponent, type TargetRequest } from "./backend.js";
import { frameworkRequestSource } from "./requests-target.js";
import { requestsArtifact } from "./request-host-source.js";
import { angularHtmlArtifact } from "./angular-html.js";
import { angularDataArtifact } from "./angular-data.js";
import { angularHostArtifact } from "./angular-host.js";
import { angularControlArtifact } from "./angular-control.js";
import { declaredStateLiteral, literalInitial, revertSource, withRevert, publishedStates } from "./state-roots.js";
import { Lowering, AUTHORED_CHECK_SOURCE, inputScope, present, typeOf, UNKNOWN, type Scope } from "./vue-lowering.js";
import { escapeHtml, isVoidElement, quote, propTypeSource, selectorGenerics, dependentPropTypeSource, slotPropsType, slotPropValueSource, svgAttributeName } from "./shared.js";
import type { GeneratedArtifact } from "../generate.js";
import { typedPropsModule } from "./vue-props.js";
import { NATIVE_PATH_WRITE_SOURCE } from "./react-control.js";
import { nativeEventsModule } from "./react-events.js";
import { DECLARED_EVENT_TYPE_SOURCE } from "./shared-generated.js";

/** JavaScript literals retain authored __proto__ fields as own data properties. */
function sourceValue(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space)?.replaceAll('"__proto__":', '["__proto__"]:') ?? "undefined";
}
const propertyKey = (name: string): string => name === "__proto__" ? `[${quote(name)}]` : quote(name);

export interface AngularOptions {
  readonly publicState?: boolean;
  readonly definitionURL?: (tag: string) => string;
  readonly controllerSpecifier?: (tag: string) => string | undefined;
  readonly componentGraph?: ReadonlyMap<string, ComponentDefinition>;
  readonly importSpecifier?: (tag: string) => string;
  readonly helperSpecifier?: (name: string) => string;
}
interface Names extends Scope {
  readonly locals: readonly string[];
  readonly statuses: Map<string, string>;
  readonly definition: ComponentDefinition;
  readonly writes: ReadonlyMap<string, string>;
  readonly handlers: ReadonlyMap<string, string>;
}
interface Projection { readonly nodes: readonly TemplateNode[]; readonly names: Names; readonly parent?: Projection }

/** Rewrite identity attribute tokens, leaving strings, authored attribute values and declarations intact. */
function identitySelectors(selector: string): string {
  let result = "";
  for (let index = 0; index < selector.length;) {
    const start = index;
    if (selector[index] === "\\") { result += selector.slice(index, index + 2); index += 2; continue; }
    if (selector[index] === '"' || selector[index] === "'") {
      const delimiter = selector[index++];
      while (index < selector.length) { if (selector[index++] === "\\") index++; else if (selector[index - 1] === delimiter) break; }
    } else if (selector[index] === "[") {
      index++;
      let delimiter = "";
      while (index < selector.length) {
        const character = selector[index++];
        if (character === "\\") { index++; continue; }
        if (delimiter !== "") { if (character === delimiter) delimiter = ""; }
        else if (character === '"' || character === "'") delimiter = character;
        else if (character === "]") break;
      }
      const attribute = selector.slice(start, index);
      const named = /^\[data-component~="([a-z][a-z0-9-]*)"\]$/.exec(attribute);
      if (named !== null) { result += `[${named[1]}]`; continue; }
      if (attribute === "[data-component]") { result += `[${VUE_ROOT_ATTRIBUTE}]`; continue; }
    } else index++;
    result += selector.slice(start, index);
  }
  return result;
}

function unsupported(message: string): never { return fail("HT018", `Angular conversion: ${message}`); }

/** Follow a delegated root without introducing an Angular host wrapper. */
function angularNativeRoot(definition: ComponentDefinition, graph: ReadonlyMap<string, ComponentDefinition>, seen = new Set<string>()): string {
  const tag = definition.contract.tag;
  if (seen.has(tag)) return unsupported(`root delegation cycles at <${tag}>.`);
  seen.add(tag);
  if (definition.template.name === "template" || definition.template.flow !== undefined && definition.template.flow.kind !== "with") return unsupported(`a structural root in <${tag}> cannot replace Angular's native host.`);
  const child = graph.get(definition.template.name);
  return child === undefined ? definition.template.name : angularNativeRoot(child, graph, seen);
}

/** A recursive view needs the converter's bounded-depth semantics, beyond a fixed native host. */
function checkRecursion(definition: ComponentDefinition, graph: ReadonlyMap<string, ComponentDefinition>, active = new Set<string>(), checked = new Set<string>()): void {
  const tag = definition.contract.tag;
  if (active.has(tag)) unsupported(`recursive component <${tag}> requires a bounded Angular template adapter.`);
  if (checked.has(tag)) return;
  active.add(tag);
  const visit = (node: TemplateNode): void => {
    if (node.kind === "text") return;
    if (node.kind === "slot") { node.fallback?.forEach(visit); return; }
    const child = graph.get(node.name);
    if (child !== undefined) checkRecursion(child, graph, active, checked);
    node.children.forEach(visit);
  };
  visit(definition.template); active.delete(tag); checked.add(tag);
}

export interface AngularConversion {
  readonly component: string;
  readonly helpers: ReadonlySet<string>;
}

export function generateAngularConversion(definition: ComponentDefinition, version: string, options: AngularOptions = {}): AngularConversion {
  const graph = new Map([...options.componentGraph ?? [], [definition.contract.tag, definition] as const]);
  const native = angularNativeRoot(definition, graph);
  checkRecursion(definition, graph);
  const generics = selectorGenerics(definition.contract.props);
  const parameters = new Map(generics.map(item => [item.from, item.parameter]));
  const lowering = new Lowering();
  const fields: string[] = [];
  const methods: string[] = [];
  const host: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, { [VUE_ROOT_ATTRIBUTE]: "" });
  const rootEvents: string[] = [];
  const rootControls: string[] = [];
  let rootHtml: string | undefined;
  const imports = new Map<string, string>();
  const helpers = new Set<string>();
  const slotDirectives = new Map<string, { name: string; selector: string; query: string; type: string }>();
  const slotImports = new Map<string, Set<string>>();
  const outlet = (slot: string, current: ComponentDefinition) => {
    let entry = slotDirectives.get(slot);
    if (entry === undefined) {
      const props = definition.contract.slots?.[slot]?.props ?? current.contract.slots?.[slot]?.props;
      entry = { name: `${definition.contract.name}${pascalCase(slot || "default")}Slot`, selector: `${definition.contract.tag}-${slot || "default"}`, query: `hnSlot${slotDirectives.size}`,
        type: props === undefined ? "Record<string, unknown>" : slotPropsType(props) };
      slotDirectives.set(slot, entry);
    }
    return entry;
  };
  const chain: ComponentDefinition[] = [];
  const models: { definition: ComponentDefinition; names: Names; raw: Map<string, string>; inputs: Map<string, string>; types: Map<string, unknown>; source?: string; requests: readonly TargetRequest[]; responders: Map<string, readonly [string, string]>; readNames: string[] }[] = [];
  const providers: string[] = [];
  const headModels: string[] = [];
  const contexts = new Map<string, string>();
  let serial = 0;
  const field = () => `hn${serial++}`;
  const helper = (name: string): void => { helpers.add(name); };
  const expression = (code: string, names: Names, hostExpression = false, tracking = false): string => {
    const name = field();
    if (hostExpression) {
      const kept = field(); fields.push(`private ${kept}: any;`);
      methods.push(`${name}(): any { const value = ${code}; if (value !== Symbol.for("html-next.invalid-result") && (typeof value !== "number" || Number.isFinite(value))) this.${kept} = value; return this.${kept}; }`);
    } else methods.push(`${name}(${names.locals.map(local => `${local}: any`).join(", ")}): any { return ${code}; }`);
    const call = `${name}(${names.locals.join(", ")})`;
    if (hostExpression || tracking) return call;
    helper("value");
    return `${call} | hnNextValue`;
  };
  const value = (plan: CompiledExpression | undefined, names: Names): string => {
    if (plan === undefined) return unsupported("a parsed expression is required.");
    return lowering.value(plan.ast, names);
  };
  const localScope = (names: Names, values: readonly (readonly [string, string, TypeNode | undefined])[]): Names => ({
    ...names, locals: [...names.locals, ...values.map(([name]) => name)],
    code: new Map([...names.code, ...values.map(([name, code]) => [name, code] as const)]),
    types: new Map([...names.types, ...values.map(([name, , type]) => [name, type === undefined ? UNKNOWN : present(type)] as const)]),
  });
  const pathWrite = (path: readonly import("../expression.js").WritablePathSegment[], code: string, names: Names, ast?: import("../expression.js").ExpressionNode): string => {
    const target = names.writes.get(String(path[0]));
    if (target === undefined) return unsupported(`write to ${String(path[0])} is not mutable state.`);
    const keys = path.slice(1).map(key => typeof key === "object" ? lowering.value(key.expression, names) : quote(String(key)));
    helper("state");
    const revert = revertSource(names.definition, path, key => lowering.value(key.expression, names));
    const next = ast !== undefined ? withRevert(code, ast, revert) : revert === undefined ? code : `revertValue(${code}, ${revert})`;
    return `this.${target}(${keys.length === 0 ? next : `updatePath(${names.code.get(String(path[0]))}, [${keys.join(", ")}], ${next})`});`;
  };
  const refs = new Map<string, string>();
  const ref = (name: string, root = false, owner = definition.contract.tag): string => {
    root ||= graph.get(owner)?.template.ref === name;
    const key = `${owner}:${name}`;
    let id = refs.get(key);
    if (id === undefined) {
      id = field(); refs.set(key, id);
      fields.push(root ? `readonly ${id} = () => [this.hnRoot];` : `readonly ${id} = viewChildren<ElementRef<Element>>(${quote(id)}, { read: ElementRef });`);
    }
    return id;
  };
  const events = (node: ElementNode, names: Names): string[] => (node.events ?? []).map(event => {
    const handler = names.handlers.get(event.handler);
    if (handler === undefined) return unsupported(`handler ${event.handler} is not declared.`);
    helper("events");
    return `{ type: ${quote(event.name)}, modifiers: ${sourceValue(event.modifiers)}, handler: (event: Event) => this.${handler}(event) }`;
  });
  const receivingProp = (child: ComponentDefinition, key: string): string | undefined => [...Object.keys(child.contract.props), ...targetComponent(child).requests.flatMap(request => [request.propName, request.callbackName])].find(name => name === key || name.toLowerCase() === key.toLowerCase() || kebabCase(name) === key);
  const bindings = (node: ElementNode, names: Names, root: boolean, child?: ComponentDefinition): string[] => {
    const attributes: string[] = root ? [] : [`data-hn-owner="${names.definition.contract.tag}"`];
    const controls: string[] = [];
    if (node.attributes.filter(attribute => attribute.kind === "attribute" && attribute.twoWay).length > 1) return unsupported("multiple two-way control bindings on one element require independent native control ownership.");
    const put = (key: string, source: string) => { if (root) {
      const previous = host[key];
      host[key] = previous !== undefined && (key === "class" || key === "style") ? `${source}${key === "class" ? " " : ";"}${previous}` : source;
    } else attributes.push(`${key}="${escapeHtml(source)}"`); };
    for (const attribute of node.attributes) {
      if (attribute.kind === "directive") continue;
      if (attribute.kind === "literal") put(attribute.name, attribute.value);
      else {
        const code = attribute.kind === "property" ? value(attribute.expressionPlan, names)
          : lowering.attribute(attribute.expressionPlan!.ast, names, attribute.name);
        if (attribute.kind === "attribute" && attribute.twoWay) {
          if (child !== undefined || !["input", "textarea", "select"].includes(node.name)) return unsupported("two-way bindings currently require a native input, textarea or select.");
          helper("control"); helper("state");
          const defaults: { value?: string; checked?: boolean; options?: boolean[] } = {};
          for (const literal of node.attributes) if (literal.kind === "literal") {
            if (literal.name === "value") defaults.value = literal.value;
            if (literal.name === "checked") defaults.checked = true;
          }
          if (node.name === "select") {
            const flags: boolean[] = [];
            const visit = (child: TemplateNode): void => {
              if (child.kind === "slot") return unsupported("two-way selects with projected options require dynamic reset defaults.");
              if (child.kind !== "element") return;
              if (child.flow !== undefined) return unsupported("two-way selects with structural options require dynamic reset defaults.");
              if (child.name === "option") flags.push(child.attributes.some(item => item.kind === "literal" && item.name === "selected"));
              child.children.forEach(visit);
            }; node.children.forEach(visit); defaults.options = flags;
          }
          const path = attribute.writablePath!;
          const update = pathWrite(path, "next", names);
          const binding = `{ name: ${quote(attribute.name)}, value: ${value(attribute.expressionPlan, names)}, defaults: ${sourceValue(defaults)}, update: (next: unknown) => { ${update} return ${value(attribute.expressionPlan, names)}; } }`;
          if (root) rootControls.push(binding);
          else controls.push(binding);
          continue;
        }
        const key = attribute.kind === "property" ? attribute.key : attribute.target === undefined ? svgAttributeName(attribute.name) : attribute.name;
        const componentInput = child === undefined ? undefined : receivingProp(child, key);
        const destination = attribute.kind === "attribute" && attribute.target !== undefined ? `${attribute.target}.${key}`
          : componentInput ?? (attribute.kind === "property" ? key : `attr.${key}`);
        const lowered = attribute.kind === "attribute" && attribute.target === "class" ? lowering.condition(attribute.expressionPlan!.ast, names)
          : attribute.kind === "attribute" && attribute.target === "style" ? lowering.text(attribute.expressionPlan!.ast, names) : code;
        put(`[${destination}]`, expression(lowered, names, root));
      }
    }
    if (controls.length > 0) attributes.push(`[hnNextControl]="${expression(`[${controls.join(", ")}]`, names)}"`);
    if (node.ref !== undefined) {
      const id = ref(node.ref, root, names.definition.contract.tag);
      if (!root) attributes.push(`#${id}`);
    }
    const listeners = events(node, names);
    if (listeners.length > 0) {
      if (root) rootEvents.push(...listeners);
      else attributes.push(`[hnNextEvents]="${expression(`[${listeners.join(", ")}]`, names)}"`);
    }
    return attributes;
  };
  const htmlBinding = (node: ElementNode, plan: CompiledExpression | undefined, names: Names): string => {
    if (node.children.some(child => child.kind !== "text" || child.expressionPlan !== undefined || child.segments !== undefined)) return unsupported("$html regions with authored child views are not supported; use an empty native element for sanitized markup.");
    helper("html");
    return `{ value: ${value(plan, names)}, owner: ${quote(names.definition.contract.tag)}, fallback: ${quote(node.children.map(child => child.kind === "text" ? child.value : "").join(""))} }`;
  };
  const renderChildren = (nodes: readonly TemplateNode[], names: Names, projection?: Projection): string => {
    let result = "";
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (node.kind === "element" && node.flow?.kind === "match") {
        const flow = node.flow;
        const alias = `local${serial++}`;
        const local = flow.alias === undefined ? names : localScope(names, [[alias, alias, undefined]]);
        const matchNames = flow.alias === undefined ? local : { ...local, code: new Map([...local.code, [flow.alias, alias]]) };
        const prefix = flow.alias === undefined ? "" : `@let ${alias} = ${expression(value(flow.expressionPlan, names), names)};`;
        let branches = "";
        for (const arm of node.children) {
          if (arm.kind !== "element" || arm.flow?.kind !== "when" && arm.flow?.kind !== "else") return unsupported("match arms must be conditional elements.");
          const markup = render({ ...arm, flow: undefined } as unknown as ElementNode, matchNames, projection);
          if (arm.flow.kind === "else") branches += ` @else {${markup}}`;
          else branches += `${branches === "" ? "@if" : " @else if"} (${expression(lowering.condition(arm.flow.testPlan!.ast, matchNames), matchNames)}) {${markup}}`;
        }
        const content = prefix + branches;
        result += node.name === "template" ? content : render({ ...elementMatchRoot(node), children: [{ kind: "text", value: "" }], flow: undefined } as unknown as ElementNode, names, projection).replace("></", `>${content}</`);
      } else result += render(node, names, projection);
    }
    return result;
  };
  const render = (node: TemplateNode, names: Names, projection?: Projection): string => {
    if (node.kind === "text") {
      if (node.segments !== undefined) return node.segments.map(segment => render(segment, names, projection)).join("");
      return node.expressionPlan === undefined ? escapeHtml(node.value).replaceAll("{", "&#123;").replaceAll("}", "&#125;").replaceAll("@", "&#64;")
        : `{{ ${expression(lowering.text(node.expressionPlan.ast, names), names)} }}`;
    }
    if (node.kind === "slot") {
      if (node.flow !== undefined) return render({ kind: "element", name: "template", attributes: [], children: [{ ...node, flow: undefined } as unknown as TemplateNode], flow: node.flow }, names, projection);
      const slot = node.name ?? "";
      const scoped = (node.props?.length ?? 0) > 0;
      const values = (node.props ?? []).map(prop => {
        const source = slotPropValueSource(names.definition, node.name, prop, true);
        if (source !== undefined && prop.type !== undefined) { helper("state"); }
        const read = `finiteResult(${value(prop.expressionPlan, names)})`; helper("state");
        return [prop.name, source === undefined ? read : `(${source})(${read})`, prop.type] as const;
      });
      if (projection !== undefined) {
        const selected = projection.nodes.filter(child => (child.kind === "element" ? child.attributes.find((attribute): attribute is import("../template.js").LiteralAttribute => attribute.kind === "literal" && attribute.name === "slot")?.value : undefined) === (slot === "" ? undefined : slot));
        if (selected.length > 0) {
          if (!scoped) return renderChildren(selected, projection.names, projection.parent);
          const carrier = selected.find((child): child is ElementNode => child.kind === "element" && child.name === "template");
          if (carrier !== undefined) {
            const locals = values.map(([name, source, type]) => ({ name, source, type, id: `local${serial++}` }));
            const scopedNames = localScope(projection.names, locals.map(item => [item.id, item.id, item.type === undefined ? undefined : normalizeType(item.type)]));
            const code = new Map(scopedNames.code); locals.forEach(item => code.set(item.name, item.id));
            return locals.map(item => `@let ${item.id} = ${expression(item.source, names)};`).join("") + renderChildren(carrier.children, { ...scopedNames, code }, projection.parent);
          }
        }
      }
      if (scoped) {
        const selected = outlet(slot, names.definition); helper("slots"); helper("state"); helper("value");
        const context = `${expression(`{ ${values.map(([name, source]) => `${propertyKey(name)}: ${source}`).join(", ")} }`, names, false, true)} | hnNextSlotValues`;
        return `@if (${selected.query}(); as supplied) {<ng-container [ngTemplateOutlet]="supplied.template" [ngTemplateOutletContext]="${context}"></ng-container>} @else {${renderChildren(node.fallback ?? [], names, projection)}}`;
      }
      return `<ng-content${slot === "" ? "" : ` select="[slot='${slot}']"`}>${renderChildren(node.fallback ?? [], names, projection)}</ng-content>`;
    }
    if (node.flow !== undefined) {
      const flow = node.flow;
      const plain = { ...node, flow: undefined } as unknown as ElementNode;
      if (flow.kind === "if") return `@if (${expression(lowering.condition(flow.testPlan!.ast, names), names)}) {${render(plain, names, projection)}}`;
      if (flow.kind === "with") {
        if (flow.binding !== undefined) helper("state");
        const id = `local${serial++}`;
        const scoped = localScope(names, [[id, id, flow.aliasType]]);
        const code = new Map(scoped.code); code.set(flow.alias, id);
        const types = new Map(scoped.types); types.set(flow.alias, flow.aliasType === undefined ? typeOf(flow.expressionPlan!.ast, names) : present(flow.aliasType));
        return `@let ${id} = ${expression(flow.binding === undefined ? value(flow.expressionPlan, names) : `requireInputStatus(${names.statuses.get(flow.binding.name) ?? "UNRESOLVED_INPUT"}, ${flow.binding.handlesError})`, names)};${render(plain, { ...scoped, code, types }, projection)}`;
      }
      if (flow.kind === "each") {
        const id = `row${serial++}`;
        const itemType = typeOf(flow.listPlan!.ast, names).type;
        const itemNames = { ...names, code: new Map([...names.code, [flow.item, "item"]]), types: new Map([...names.types, [flow.item, itemType.kind === "list" ? present(itemType.item) : UNKNOWN]]) };
        const list = lowering.list(flow.listPlan!.ast, names, "item", { itemScope: itemNames,
          ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
          sort: flow.sortKeys?.map(key => `${key.descending ? "-" : ""}${key.path.join(".")}`) ?? [], ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }) });
        const scoped = localScope(names, [[id, id, undefined]]);
        const code = new Map(scoped.code); code.set(flow.item, `${id}.item`); code.set("loop", `${id}.loop`);
        if (flow.index !== undefined) code.set(flow.index, `${id}.index`);
        const loopNames = { ...scoped, code, types: new Map([...scoped.types, [flow.item, itemType.kind === "list" ? present(itemType.item) : UNKNOWN]]) };
        const keyScope = { ...itemNames, code: new Map([...itemNames.code, ["loop", "loop"], ...(flow.index === undefined ? [] : [[flow.index, "index"] as const])]) };
        const unique = flow.keyPlan === undefined ? list : lowering.uniqueKeys(list, `(item: any, index: number, loop: any) => ${value(flow.keyPlan, keyScope)}`);
        const rows = lowering.eachRows(unique);
        return `@for (${id} of ${expression(rows, names)}; track ${flow.keyPlan === undefined ? `${id}.index` : expression(value(flow.keyPlan, loopNames), loopNames, false, true)}) {${render(plain, loopNames, projection)}}`;
      }
      if (flow.kind !== "match") return unsupported(`orphan ${flow.kind} directive.`);
    }
    if (node.name === "template") {
      const content = node.attributes.find(attribute => attribute.kind === "directive");
      if (content?.kind === "directive") {
        if (content.name === "html") return unsupported("template $html needs the shared sanitizer adapter.");
        return `{{ ${expression(lowering.text(content.expressionPlan!.ast, names), names)} }}`;
      }
      return renderChildren(node.children, names, projection);
    }
    const child = graph.get(node.name);
    let tag = node.name;
    const attributes = bindings(node, names, false, child);
    if (child !== undefined) {
      tag = angularNativeRoot(child, graph);
      attributes.unshift(child.contract.tag);
      imports.set(child.contract.tag, child.contract.name);
    }
    const directive = node.attributes.find(attribute => attribute.kind === "directive");
    if (directive?.kind === "directive" && directive.name === "html") attributes.push(`[hnNextHtml]="${expression(htmlBinding(node, directive.expressionPlan, names), names)}"`);
    const project = (): string => {
      if (child === undefined) return renderChildren(node.children, names, projection);
      return node.children.map(projected => {
        const slot = projected.kind !== "element" ? undefined : projected.attributes.find(attribute => attribute.kind === "literal" && attribute.name === "slot");
        const contract = slot?.kind === "literal" ? child.contract.slots?.[slot.value] : undefined;
        if (projected.kind !== "element" || projected.name !== "template" || slot?.kind !== "literal") return render(projected, names, projection);
        if (contract === undefined || Object.keys(contract.props).length === 0) return `<ng-container ngProjectAs="[slot='${slot.value}']">${renderChildren(projected.children, names, projection)}</ng-container>`;
        const directive = `${child.contract.name}${pascalCase(slot.value || "default")}Slot`;
        const imported = slotImports.get(child.contract.tag) ?? new Set(); imported.add(directive); slotImports.set(child.contract.tag, imported);
        const locals = Object.entries(contract.props).map(([name, prop]) => ({ name, type: normalizeType(prop.type), id: `local${serial++}` }));
        const scoped = localScope(names, locals.map(item => [item.id, item.id, item.type]));
        const code = new Map(scoped.code); locals.forEach(item => code.set(item.name, item.id));
        return `<ng-template ${child.contract.tag}-${slot.value || "default"} ${locals.map(item => `let-${item.id}="${item.name}"`).join(" ")}>${renderChildren(projected.children, { ...scoped, code }, projection)}</ng-template>`;
      }).join("");
    };
    const content = directive?.kind === "directive" && directive.name === "html" ? "" : directive?.kind === "directive" ? `{{ ${expression(lowering.text(directive.expressionPlan!.ast, names), names)} }}` : project();
    const open = `<${tag}${attributes.length === 0 ? "" : " " + attributes.join(" ")}>`;
    return isVoidElement(tag) ? open : `${open}${content}</${tag}>`;
  };
  const compose = (current: ComponentDefinition, supplied?: ReadonlyMap<string, string>, projection?: Projection): string => {
    chain.push(current);

    const source = current.controller === undefined && current.module === undefined ? undefined : field();
    if (source !== undefined) fields.push(`readonly ${source} = signal<Record<string, InputSnapshot>>({});`);
    const raw = new Map<string, string>();
    const inputs = new Map<string, string>();
    const propTypes = new Map<string, unknown>();
    const code = new Map<string, string>();
    const types = new Map<string, import("./vue-lowering.js").Static>();
    const writes = new Map<string, string>();
    const handlers = new Map<string, string>();
    const statuses = new Map<string, string>();
    const names: Names = { code, types, writes, handlers, statuses, locals: [], definition: current };
    const declarationIds = new Map<string, string>();
    for (const declaration of current.declarations ?? []) {
      if (declaration.kind === "handler" || declaration.kind === "event") continue;
      const name = declaration.kind === "context" ? declaration.as ?? declaration.name : declaration.name;
      const id = field(); declarationIds.set(name, id); code.set(name, `this.${id}()`);
      const type = declaration.kind === "context" || declaration.kind === "data" ? undefined : declarationTypeNode(declaration.type, declaration.shape);
      types.set(name, type === undefined ? UNKNOWN : present(type));
      statuses.set(name, declaration.kind === "computed" || declaration.kind === "state" && declaration.initializer !== undefined ? `this.${id}.status()` : "READY_INPUT");
    }
    const propFields = new Map(Object.keys(current.contract.props).map(name => [name, { input: field(), accepted: field(), checked: field() }]));
    for (const [name, ids] of propFields) code.set(name, `this.${ids.checked}()`);
    for (const [name, prop] of Object.entries(current.contract.props)) {
      const { input: id, accepted, checked } = propFields.get(name)!;
      const type = supplied !== undefined ? propTypeSource(prop) : parameters.get(name) ?? (prop.select === undefined ? propTypeSource(prop) : `NoInfer<${dependentPropTypeSource(prop, parameters)}>`);
      const constraints = Object.fromEntries(["values", "pattern", "min", "max", "minLength", "maxLength"].flatMap(key => prop[key as keyof typeof prop] === undefined ? [] : [[key, prop[key as keyof typeof prop]]]));
      const runtimeType = Object.keys(constraints).length === 0 ? normalizeType(prop.type) : { kind: "constrained", base: normalizeType(prop.type), ...constraints };
      const initial = prop.default === undefined ? "undefined" : sourceValue(prop.default);
      propTypes.set(name, prop.select === undefined ? runtimeType : { kind: "union", members: prop.select.options.map(item => item.type) });
      const runtimeSource = prop.select === undefined ? sourceValue(runtimeType) : `selectedPropNode(${code.get(prop.select.from) ?? "undefined"}, ${sourceValue(prop.select.options)})`;
      if (supplied === undefined) fields.push(prop.required && prop.default === undefined
        ? `readonly ${id} = input.required<${type}>({ alias: ${quote(name)} });`
        : `readonly ${id} = input<${type} | undefined>(undefined, { alias: ${quote(name)} });`);
      else fields.push(`readonly ${id} = computed<any>(() => ${supplied.get(name) ?? "undefined"});`);
      helper("state");
      fields.push(`readonly ${accepted}: Record<string, unknown> = {};`);
      raw.set(name, `this.${id}()`);
      const status = `(this.${id}() !== undefined ? READY_INPUT : ${source === undefined ? "" : `this.${source}()[${quote(name)}]?.status ?? `}${initial === "undefined" ? "UNRESOLVED_INPUT" : "READY_INPUT"})`;
      const incoming = `this.${id}() !== undefined ? this.${id}() : ${source === undefined ? initial : `this.${source}()[${quote(name)}] === undefined ? ${initial} : this.${source}()[${quote(name)}]!.value`}`;
      inputs.set(name, incoming);
      fields.push(`readonly ${checked} = computed<${type}>(() => ${status}.ready ? checkedProp<${type}>(${incoming}, ${runtimeSource}, ${prop.required}, ${quote(name)}, this.${accepted}) as ${type} : (this.${accepted}[${quote(name)}] ?? ${initial === "undefined" ? "null" : initial}) as ${type});`);
      statuses.set(name, status);
      contexts.set(`${current.contract.tag}:${name}`, `this.${checked}`);
      code.set(name, `this.${checked}()`); types.set(name, { ...present(normalizeType(prop.type)), nullable: !prop.required && prop.default === undefined });
    }
    const target = targetComponent(current);
    const requests = target.requests;
    const responders = new Map<string, readonly [string, string]>();
    for (const request of requests) {
      helper("requests"); helper("state");
      const respond = field(), listen = field();
      const type = `Responder<${request.detailType}, ${request.answerType}>`;
      const listener = `(event: RequestEvent<${request.detailType}, ${request.answerType}>) => void`;
      fields.push(supplied === undefined ? `readonly ${respond} = input<${type} | undefined>(undefined, { alias: ${quote(request.propName)} });`
        : `readonly ${respond} = computed<${type} | undefined>(() => ${supplied.get(request.propName) ?? "undefined"});`);
      fields.push(supplied === undefined ? `readonly ${listen} = input<(${listener}) | undefined>(undefined, { alias: ${quote(request.callbackName)} });`
        : `readonly ${listen} = computed<(${listener}) | undefined>(() => ${supplied.get(request.callbackName) ?? "undefined"});`);
      responders.set(request.name, [respond, listen]);
    }
    const scriptNames = new Map<string, string>();
    for (const script of current.scripts ?? []) if (script.name !== undefined) {
      const id = field(); scriptNames.set(script.name, id);
      fields.push(`readonly ${id} = signal<ScriptStatus>({ pending: false, ok: false, error: null });`);
      code.set(script.name, `this.${id}()`); types.set(script.name, UNKNOWN); statuses.set(script.name, "READY_INPUT");
    }
    for (const declaration of current.declarations ?? []) {
      if (declaration.kind === "handler") { handlers.set(declaration.name, field()); continue; }
      if (declaration.kind === "event") continue;

      const id = declarationIds.get(declaration.kind === "context" ? declaration.as ?? declaration.name : declaration.name)!;
      if (declaration.kind === "data") {
        helper("data");
        const sources = declaration.parameters.filter(parameter => parameter.mode === "from").map(parameter => value(parameter.expression, names));
        const parameters = declaration.parameters.map(parameter => `${propertyKey(parameter.name)}: ${value(parameter.expression, names)}`);
        fields.push(`readonly ${id}: Signal<any> = createDataRead(this.hnRoot.nativeElement, {
          ${declaration.source === undefined ? "" : `source: ${quote(declaration.source)},`}
          definition: ${quote(options.definitionURL?.(current.contract.tag) ?? current.source.file)},
          ${declaration.type === undefined ? "" : `type: ${quote(declaration.type)},`}
          ${declaration.debounce === undefined ? "" : `debounce: ${parseDuration(declaration.debounce)},`}
          ${declaration.poll === undefined ? "" : `poll: ${parseDuration(declaration.poll)},`}
          sources: () => [${sources.join(", ")}], parameters: () => ({ ${parameters.join(", ")} })
        });`);
        types.set(declaration.name, UNKNOWN); statuses.set(declaration.name, "READY_INPUT"); continue;
      }
      if (declaration.kind === "context") {
        helper("context");
        fields.push(`readonly ${id}: Signal<any> = ${contexts.get(`${declaration.from}:${declaration.name}`) ?? `inject<Signal<any>>(contextToken(${quote(`${declaration.from}:${declaration.name}`)}), { skipSelf: true })`};`);
        types.set(declaration.as ?? declaration.name, UNKNOWN);
        statuses.set(declaration.as ?? declaration.name, `(this.${id} as Signal<any> & { status?: () => InputStatus }).status?.() ?? (this.${id}() === undefined ? UNRESOLVED_INPUT : READY_INPUT)`); continue;
      }
      const type = declarationTypeNode(declaration.type, declaration.shape);
      types.set(declaration.name, type === undefined ? UNKNOWN : present(type));
      if (declaration.kind === "state") {
        const setter = field(); writes.set(declaration.name, setter);
        const literal = declaration.expression === undefined ? undefined : literalInitial(declaration.expression.ast);
        const parsed = declaration.value === undefined || type === undefined ? undefined : parseTypedValue(declaration.value, type);
        const initial = literal !== undefined ? sourceValue(literal.value) : parsed?.ok ? sourceValue(parsed.value) : "null";
        if (initial === "null" || declaration.initializer !== undefined) types.set(declaration.name, type === undefined ? UNKNOWN : { ...present(type), nullable: true });
        if (declaration.initializer !== undefined) {
          fields.push(`readonly ${id}: InitializedSignal = initializedState(() => evaluateInput(() => ${value(declaration.initializer, inputScope(names, name => statuses.get(name)))}), ${sourceValue(type ?? UNKNOWN.type)});`);
          statuses.set(declaration.name, `this.${id}.status()`);
        } else {
          fields.push(`readonly ${id} = signal<${type === undefined ? "any" : typeScriptType(type)}${initial === "null" ? " | null" : ""}>(${initial});`);
          statuses.set(declaration.name, "READY_INPUT");
        }
        helper("state");
        methods.push(`${setter}(value: unknown): void { if (value === Symbol.for("html-next.invalid-result") || typeof value === "number" && !Number.isFinite(value)) return; const result = checkPropInput(value, ${sourceValue(type ?? UNKNOWN.type)}, false); if (result.ok) this.${id}.set(result.value as any); }`);
      } else {
        helper("state");
        fields.push(`readonly ${id}: TrackedSignal = retainedComputed(() => evaluateInput(() => ${value(declaration.expression, inputScope(names, name => statuses.get(name)))}), ${sourceValue(type ?? UNKNOWN.type)});`);
        statuses.set(declaration.name, `this.${id}.status()`);
      }
      contexts.set(`${current.contract.tag}:${declaration.name}`, `this.${id}`);
      if (options.publicState === true || publishedStates(current, graph.values()).has(declaration.name)) providers.push(`{ provide: contextToken(${quote(`${current.contract.tag}:${declaration.name}`)}), useFactory: () => inject(${definition.contract.name}).${id} }`);
    }
    const handlerNames = { ...names, code: new Map([...code, ["event", "event"]]), types: new Map([...types, ["event", UNKNOWN]]) };
    for (const declaration of current.declarations ?? []) {
      if (declaration.kind !== "handler") continue;
      const handler = declaration as HandlerDeclaration;
      const steps = handler.steps.map(step => {
        let statement: string;
        if (step.kind === "set") statement = pathWrite(step.writablePath, value(step.value, handlerNames), handlerNames, step.value.ast);
        else if (step.kind === "dispatch") {
          const event = current.declarations?.find(item => item.kind === "event" && item.name === step.event);
          if (event?.kind !== "event") return unsupported(`event ${step.event} is not declared.`);
          helper("events"); helper("state");
          const target = step.target === undefined ? "[this.hnRoot]" : `this.${ref(step.target, false, current.contract.tag)}()`;
          statement = `dispatchDeclaredTargets(${target}.map(item => item.nativeElement), ${quote(event.name)}, ${step.value === undefined ? "undefined" : value(step.value, handlerNames)}, ${sourceValue(declarationTypeNode(event.type, event.shape))}, ${sourceValue({ bubbles: event.bubbles, composed: event.composed, cancelable: event.cancelable })});`;
        } else {
          const targets = `this.${ref(step.target, false, current.contract.tag)}()`;
          statement = `for (const target of ${targets}) { const element = target.nativeElement as HTMLElement & { reportValidity?(): boolean }; ${step.kind === "focus" ? "element.focus();" : "element.reportValidity?.();"} }`;
        }
        return step.guard === undefined ? statement : `if (${lowering.condition(step.guard.ast, handlerNames)}) { ${statement} }`;
      });
      methods.push(`${handlers.get(handler.name)}(event: Event): void { ${steps.join("\n")} }`);
    }
    if (current.head !== undefined || current.scripts !== undefined) {
      helper("head");
      const kept = field(); fields.push(`readonly ${kept}: unknown[] = [];`);
      const entries = headEntriesSource(current, plan => value(plan, names), `this.${kept}`);
      const scripts = headScriptsSource({ ...current, source: { ...current.source, file: options.definitionURL?.(current.contract.tag) ?? current.source.file } },
        (name, event) => `this.${handlers.get(name)}(${event})`, name => ({ read: `this.${scriptNames.get(name)}()`, write: next => `this.${scriptNames.get(name)}.set(${next})` }));
      headModels.push(`{ tag: ${quote(current.contract.tag)}, entries: () => ${entries}, scripts: ${scripts} }`);
    }
    if (source !== undefined || current.lifecycle !== undefined || requests.length > 0) models.push({ definition: current, names, raw, inputs, requests, responders, types: propTypes,
      ...(source === undefined ? {} : { source }), readNames: [...code.keys()].filter(name => !(current.declarations ?? []).some(item => item.kind === "data" && item.name === name)) });
    host[current.contract.tag] = "";
    const root = current.template;
    if (root.flow?.kind === "with") {
      if (root.flow.binding !== undefined) helper("state");
      const id = field();
      fields.push(`readonly ${id} = computed<any>(() => ${root.flow.binding === undefined ? value(root.flow.expressionPlan, names) : `requireInputStatus(${names.statuses.get(root.flow.binding.name) ?? "UNRESOLVED_INPUT"}, ${root.flow.binding.handlesError})`});`);
      code.set(root.flow.alias, `this.${id}()`);
      types.set(root.flow.alias, root.flow.aliasType === undefined ? typeOf(root.flow.expressionPlan!.ast, names) : present(root.flow.aliasType));
    }
    const child = graph.get(root.name);
    const reflect = (): void => {
      for (const [name, prop] of Object.entries(current.contract.props)) {
        const key = prop.target.attribute === undefined ? `[${prop.target.property}]` : `[attr.${prop.target.attribute}]`;
        if (host[key] === undefined) host[key] = expression(prop.target.attribute === undefined ? code.get(name)! : `${lowering.use("attribute")}(${code.get(name)})`, names, true);
      }
    };
    if (child !== undefined) {
      rootEvents.push(...events(root, names));
      if (root.ref !== undefined) ref(root.ref, true, current.contract.tag);
      const childProps = new Map<string, string>();
      for (const attribute of root.attributes) {
        const key = attribute.kind === "property" ? attribute.key : attribute.kind !== "directive" ? attribute.name : "";
        const inputName = receivingProp(child, key);
        if (inputName !== undefined) childProps.set(inputName, attribute.kind === "literal" ? quote(attribute.value) : value(attribute.expressionPlan, names));
      }
      const markup = compose(child, childProps, { nodes: root.children, names, ...(projection === undefined ? {} : { parent: projection }) });
      const outer = { ...root, attributes: root.attributes.filter(attribute => attribute.kind !== "directive" && receivingProp(child, attribute.kind === "property" ? attribute.key : attribute.name) === undefined), events: [], ref: undefined } as unknown as ElementNode;
      bindings(outer, names, true);
      reflect();
      return markup;
    }
    bindings(root, names, true);
    reflect();
    const directive = root.attributes.find(attribute => attribute.kind === "directive");
    if (directive?.kind === "directive") {
      if (directive.name === "html") { rootHtml = htmlBinding(root, directive.expressionPlan, names); return ""; }
      host["[textContent]"] = expression(lowering.text(directive.expressionPlan!.ast, names), names, true);
      return "";
    }
    return renderChildren(root.children, names, projection);
  };
  const template = compose(definition);
  const hostModels = models.map(model => {
    helper("host"); helper("state"); helper("events");
    const { definition: current, names } = model;
    const mutable = (current.declarations ?? []).filter((item): item is import("../template.js").ReactiveDeclaration => item.kind === "state");
    const immutable = (current.declarations ?? []).filter((item): item is import("../template.js").ReactiveDeclaration | import("../template.js").ContextDeclaration => item.kind === "computed" || item.kind === "context");
    const props = Object.keys(current.contract.props);
    const entries = (names: readonly string[], read: (name: string) => string) => `{ ${names.map(name => `${propertyKey(name)}: ${read(name)}`).join(", ")} }`;
    const loader = options.controllerSpecifier?.(current.contract.tag) ?? current.module ?? current.controller;
    const contract = { props: Object.fromEntries(Object.entries(current.contract.props).map(([name, prop]) => [name, { type: prop.select === undefined ? normalizeType(prop.type) : { kind: "union", members: prop.select.options.map(item => item.type) }, ...(prop.select === undefined ? {} : { select: prop.select }), required: prop.required, ...Object.fromEntries(["values", "pattern", "min", "max", "minLength", "maxLength"].flatMap(key => prop[key as keyof typeof prop] === undefined ? [] : [[key, prop[key as keyof typeof prop]]])) }])) };
    const declared = Object.fromEntries((current.declarations ?? []).flatMap(item => item.kind === "event" ? [[item.name, [declarationTypeNode(item.type, item.shape), { bubbles: item.bubbles, composed: item.composed, cancelable: item.cancelable }]]] : []));
    const multiplicity = iteratedRefNames(current);
    const modelRefs = [...refs].filter(([key]) => key.startsWith(current.contract.tag + ":")).map(([key, field]) => {
      const name = key.slice(current.contract.tag.length + 1);
      return `${propertyKey(name)}: () => this.${field}().map(item => item.nativeElement)${multiplicity.has(name) ? "" : "[0]"}`;
    });
    const stateTypes = Object.fromEntries(mutable.map(item => [item.name, declarationTypeNode(item.type, item.shape)]));
    const publish = model.source === undefined ? "" : `publish: (name: string, snapshot: InputSnapshot): boolean => {
      if ((${entries(props, name => model.raw.get(name)!) } as Record<string, unknown>)[name] !== undefined) return false;
      const parsed = !snapshot.status.ready && snapshot.value === undefined ? { ok: true, value: undefined } : checkPropInput(snapshot.value, (${sourceValue(Object.fromEntries(model.types))} as Record<string, any>)[name], true);
      if (!parsed.ok) return false;
      this.${model.source}.update(values => ({ ...values, [name]: { value: parsed.value, status: snapshot.status } })); return true;
    },`;
    return `{ tag: ${quote(current.contract.tag)}, definition: ${quote(options.definitionURL?.(current.contract.tag) ?? current.source.file)}, ${loader === undefined ? "" : `controller: ${quote(loader)}, module: ${current.module !== undefined}, load: () => import(${quote(loader)}),`}
      props: () => (${entries(props, name => names.code.get(name)!)}), rawProps: () => (${entries(props, name => model.inputs.get(name)!)}), callerProps: () => (${entries(props, name => model.raw.get(name)!)}),
      propContract: ${sourceValue(contract)},
      ${current.scripts === undefined ? "" : `scripts: () => this.hnHead.scripts(${quote(current.contract.tag)}),`}
      ${model.requests.length === 0 ? "" : `request: ${frameworkRequestSource(model.requests, options.definitionURL?.(current.contract.tag) ?? current.source.file)},
      responders: { ${model.requests.map(request => `${propertyKey(request.name)}: () => propResponder(this.${model.responders.get(request.name)![0]}(), this.${model.responders.get(request.name)![1]}())`).join(", ")} },`}

      state: ${entries(mutable.map(item => item.name), name => `{ get: () => ${names.code.get(name)}, set: value => this.${names.writes.get(name)}(value) }`)},
      computed: ${entries(immutable.map(item => item.kind === "context" ? item.as ?? item.name : item.name), name => `() => ${names.code.get(name)}`)},
      data: ${entries((current.declarations ?? []).flatMap(item => item.kind === "data" ? [item.name] : []), name => `() => ${names.code.get(name)}`)},
      initials: ${sourceValue(Object.fromEntries(mutable.map(item => [item.name, declaredStateLiteral(current, item.name)])))},
      acceptsState: (name: string, keys: readonly string[], value: unknown) => acceptsControllerWrite(value, (${sourceValue(stateTypes)} as Record<string, any>)[name], keys),
      changed: (name: string) => { ${mutable.map(item => `if (name === ${quote(item.name)}) this.${names.writes.get(item.name)}(copyStateSeed(${names.code.get(item.name)}));`).join(" ")} },
      reads: ${entries(model.readNames, name => `() => ${names.code.get(name)}`)}, availability: ${entries(model.readNames, name => `() => ${names.statuses.get(name) ?? "READY_INPUT"}`)},
      ${publish} refs: { ${modelRefs.join(", ")} }, events: ${sourceValue(declared)},
      ${current.lifecycle?.connect === undefined ? "" : `connect: () => this.${names.handlers.get(current.lifecycle.connect)}(new Event("connect")),`}
      ${current.lifecycle?.disconnect === undefined ? "" : `disconnect: () => this.${names.handlers.get(current.lifecycle.disconnect)}(new Event("disconnect")),`}
    }`;
  });
  // Every root's state tokens use the shared selector contract, including delegated owners.
  for (const current of chain) {
    const tested = componentStateNames(current, graph);
    if (tested.length === 0) continue;
    helper("state");
    const values = tested.map(name => `${propertyKey(name)}: ${contexts.get(`${current.contract.tag}:${name}`) === undefined ? "undefined" : `${contexts.get(`${current.contract.tag}:${name}`)}()`}`);
    const method = field(); methods.push(`${method}(): string { return stateTokens({ ${values.join(", ")} }); }`);
    host[`[attr.${stateAttribute(current.contract.tag)}]`] = `${method}()`;
  }
  const styles = postcss.parse(compileComponentGraphStylesForBuild([...graph.values()].filter(item => chain.includes(item)), graph));
  styles.walkRules(rule => { rule.selector = identitySelectors(rule.selector); });
  styles.walkAtRules("scope", rule => { rule.params = identitySelectors(rule.params); });
  const usesProjection = template.includes("<ng-content") || slotDirectives.size > 0;
  if (usesProjection) helpers.add("projection");
  const usesSlots = helpers.has("slots");
  const usesHead = helpers.has("head");
  const usesRequests = helpers.has("requests");
  const usesHtml = helpers.has("html");
  if (rootHtml !== undefined) host[`[attr.${VUE_ROOT_ATTRIBUTE}]`] = "hnRootBindings()";
  const usesData = helpers.has("data");
  const usesHost = helpers.has("host");
  const usesValue = helpers.has("value");
  const usesControl = helpers.has("control");
  if (rootControls.length > 0) host[`[attr.${VUE_ROOT_ATTRIBUTE}]`] = "hnRootBindings()";
  const usesEvents = helpers.has("events");
  if (usesEvents) helpers.add("state");
  const hasContext = providers.length > 0 || helpers.has("context");
  if (hasContext) helper("context");
  const helperPath = (name: string) => quote(options.helperSpecifier?.(name) ?? `./${name}`);
  const component = `// Generated Angular component by HTML Next ${version}. Do not edit.\nimport { Component, ChangeDetectionStrategy, ViewEncapsulation, ElementRef, inject, input, signal, computed, viewChildren, contentChild, Directive, TemplateRef, type Signal } from "@angular/core";\n${[...imports].map(([tag, name]) => `import ${name}${slotImports.has(tag) ? `, { ${[...slotImports.get(tag)!].join(", ")} }` : ""} from ${quote(options.importSpecifier?.(tag) ?? `./${name}`)};`).join("\n")}\n${helpers.has("state") ? `import { checkedProp, checkPropInput, updatePath, stateTokens, revertValue, evaluateInput, inputRead, requireInputStatus, READY_INPUT, UNRESOLVED_INPUT, initializedState, retainedComputed, type TrackedSignal, type InitializedSignal, type InputSnapshot, type InputStatus, acceptsControllerWrite, copyStateSeed, warnUnless, finiteResult, acceptsDeclaredEvent, acceptsDeclaredEvent as acceptsSlotProp, selectedPropNode } from ${helperPath("state")};` : ""}\n${usesSlots ? `import { NgTemplateOutlet } from "@angular/common";` : ""}\n${usesHead ? `import { HtmlNextHead, headText, headAttribute, headAttributes, headJson, type HeadEntry, type HeadScript, type DeclaredScript, type ScriptStatus } from ${helperPath("head")};` : ""}\n${usesRequests ? `import { frameworkRequest, propResponder, type RequestEvent, type Responder } from ${helperPath("requests")};` : ""}\n${usesHtml ? `import { HtmlNextHtml } from ${helperPath("html")};` : ""}\n${usesData ? `import { createDataRead } from ${helperPath("data")};` : ""}\n${usesHost ? `import { HtmlNextHost } from ${helperPath("host")};` : ""}\n${usesValue ? `import { HtmlNextValue${usesSlots ? ", HtmlNextSlotValues" : ""} } from ${helperPath("value")};` : ""}\n${usesControl ? `import { HtmlNextControl } from ${helperPath("control")};` : ""}\n${usesProjection ? `import { HtmlNextProjection } from ${helperPath("projection")};` : ""}\n${usesEvents ? `import { HtmlNextEvents, dispatchDeclaredTargets } from ${helperPath("events")};` : ""}\n${hasContext ? `import { contextToken } from ${helperPath("context")};` : ""}\n${lowering.moduleFallbacks().join("\n")}\n${lowering.fallbacks().join("\n")}\n${targetComponent(definition).events.length === 0 ? "" : `export interface ${definition.contract.name}Events { ${targetComponent(definition).events.map(event => `readonly ${propertyKey(event.name)}: CustomEvent<${event.detailType}>;`).join(" ")} }`}\n${[...slotDirectives.values()].map(slot => `@Directive({ selector: ${quote(`ng-template[${slot.selector}]`)}, standalone: true })
export class ${slot.name} {
  readonly template = inject<TemplateRef<${slot.type}>>(TemplateRef);
  static ngTemplateContextGuard(_directive: ${slot.name}, _context: unknown): _context is ${slot.type} { return true; }
}`).join("\n")}\n@Component({\n  selector: ${quote(`${native}[${definition.contract.tag}]`)},\n  standalone: true,\n  imports: [${[...imports.values(), ...[...slotImports.values()].flatMap(names => [...names]), ...(usesSlots ? ["NgTemplateOutlet", "HtmlNextSlotValues"] : []), ...(usesEvents ? ["HtmlNextEvents"] : []), ...(usesControl ? ["HtmlNextControl"] : []), ...(usesValue ? ["HtmlNextValue"] : []), ...(usesHtml ? ["HtmlNextHtml"] : [])].join(", ")}],\n  ${rootEvents.length === 0 && rootControls.length === 0 && !usesProjection && !usesHost && !usesHead && rootHtml === undefined ? "" : `hostDirectives: [${[...(rootEvents.length > 0 ? ["HtmlNextEvents"] : []), ...(usesProjection ? ["HtmlNextProjection"] : []), ...(rootControls.length > 0 ? ["HtmlNextControl"] : []), ...(usesHost ? ["HtmlNextHost"] : []), ...(usesHead ? ["HtmlNextHead"] : []), ...(rootHtml === undefined ? [] : ["HtmlNextHtml"])].join(", ")}],`}\n  changeDetection: ChangeDetectionStrategy.OnPush,\n  encapsulation: ViewEncapsulation.None,\n  host: ${sourceValue(host, 2)},\n  ${hasContext ? `providers: [${providers.join(", ")}],` : ""}\n  template: ${quote(template)},\n  styles: [${quote(styles.toString())}]\n})\nexport default class ${definition.contract.name}${generics.length === 0 ? "" : `<${generics.map(item => item.declaration).join(", ")}>`} {\n  readonly hnRoot = inject<ElementRef<HTMLElement>>(ElementRef);\n  ${usesHost ? "readonly hnHost = inject(HtmlNextHost);" : ""}\n  ${usesHead ? "readonly hnHead = inject(HtmlNextHead);" : ""}\n  ${rootControls.length === 0 ? "" : `readonly hnControl = inject(HtmlNextControl);`}\n  ${rootHtml === undefined ? "" : `readonly hnHtml = inject(HtmlNextHtml);`}\n  ${rootControls.length === 0 && rootHtml === undefined ? "" : `hnRootBindings(): string { ${rootControls.length === 0 ? "" : `this.hnControl.bindings = [${rootControls.join(", ")}];`} ${rootHtml === undefined ? "" : `this.hnHtml.binding = ${rootHtml};`} return ""; }`}\n  ${[...slotDirectives.values()].map(slot => `readonly ${slot.query} = contentChild(${slot.name});`).join("\n  ")}\n  ${fields.join("\n  ")}\n  ${methods.join("\n  ")}\n  ${rootEvents.length === 0 ? "" : `readonly hnEvents = inject(HtmlNextEvents);`}\n  ${usesProjection ? `readonly hnProjection = inject(HtmlNextProjection);` : ""}\n  ${rootEvents.length === 0 && rootControls.length === 0 && !usesProjection && !usesHost && !usesHead && rootHtml === undefined ? "" : `ngOnInit(): void { ${usesHead ? `this.hnHead.models = [${headModels.join(", ")}];` : ""} ${usesHost ? `this.hnHost.models = [${hostModels.join(", ")}];` : ""} ${rootEvents.length === 0 ? "" : `this.hnEvents.bindings = [${rootEvents.join(", ")}]; this.hnEvents.ngOnChanges();`} ${usesProjection ? `this.hnProjection.owners = ${sourceValue(chain.map(item => item.contract.tag))};` : ""} }`}\n}\n`;
  return { component, helpers };
}

export function angularArtifacts(version: string, helpers?: ReadonlySet<string>): readonly GeneratedArtifact[] {
  return [
    angularControlArtifact(version),
    angularHostArtifact(version),
    angularDataArtifact(version),
    angularHtmlArtifact(version),
    headHelperArtifact("angular", version),
    requestsArtifact("angular", version),
    { path: "angular/value.ts", content: `import { Pipe } from "@angular/core";
@Pipe({ name: "hnNextValue", standalone: true, pure: false })
export class HtmlNextValue {
  private accepted: any;
  transform(value: any): any {
    if (value !== Symbol.for("html-next.invalid-result") && (typeof value !== "number" || Number.isFinite(value))) this.accepted = value;
    return this.accepted;
  }
}
/** Each embedded view retains each slot prop independently when its expression is invalid. */
@Pipe({ name: "hnNextSlotValues", standalone: true, pure: false })
export class HtmlNextSlotValues {
  private accepted: Record<string, unknown> = Object.create(null);
  transform(values: Record<string, unknown>): any {
    let next = this.accepted;
    for (const [name, value] of Object.entries(values)) {
      if (value === Symbol.for("html-next.invalid-result") || typeof value === "number" && !Number.isFinite(value)) continue;
      if (!Object.is(this.accepted[name], value)) {
        if (next === this.accepted) next = { ...this.accepted };
        Object.defineProperty(next, name, { value, configurable: true, enumerable: true, writable: true });
      }
    }
    return this.accepted = next;
  }
}\n` },
    { path: "angular/state.ts", content: `import { computed, signal, type Signal } from "@angular/core";\n${typedPropsModule(version)}\n${DECLARED_EVENT_TYPE_SOURCE}
${AUTHORED_CHECK_SOURCE}
export function finiteResult(value: unknown): unknown { return typeof value === "number" && !Number.isFinite(value) ? Symbol.for("html-next.invalid-result") : value; }
export type TrackedSignal = Signal<any> & { status(): InputStatus };
export function retainedComputed(evaluate: () => { value: unknown; status: InputStatus }, type: Parameters<typeof checkPropInput>[1]): TrackedSignal {
  let accepted: unknown = null;
  const evaluated = computed(() => {
    const next = evaluate();
    if (next.status.ready && next.value !== undefined && next.value !== Symbol.for("html-next.invalid-result")) {
      const checked = checkPropInput(next.value, type, false);
      if (checked.ok) accepted = checked.value;
    }
    return { value: accepted, status: next.status };
  });
  return Object.assign(computed<any>(() => evaluated().value), { status: () => evaluated().status });
}
export type InitializedSignal = TrackedSignal & { set(next: unknown): void };
export function initializedState(evaluate: () => { value: unknown; status: InputStatus }, type: Parameters<typeof checkPropInput>[1]): InitializedSignal {
  let initialized = false;
  let value: unknown;
  const version = signal(0);
  const current = computed(() => {
    version();
    if (!initialized) {
      const next = evaluate();
      const accepted = next.status.ready && next.value !== undefined ? checkPropInput(next.value, type, false) : undefined;
      if (accepted?.ok) { initialized = true; value = copyStateSeed(accepted.value); }
      else return { value: undefined, status: next.status };
    }
    return { value, status: READY_INPUT };
  });
  return Object.assign(computed<any>(() => current().value), { status: () => current().status,
    set(next: unknown): void { initialized = true; value = next; version.update(value => value + 1); } });
}
\nexport function revertValue(value: unknown, fallback: unknown): unknown { return value ?? fallback; }\n${NATIVE_PATH_WRITE_SOURCE.replace("writeBoundPath", "updatePath")}\nexport function stateTokens(values: Record<string, unknown>): string {\n  return Object.entries(values).flatMap(([name, value]) => [\n    ...(value === true || typeof value === "string" && value.length > 0 || typeof value === "number" && value !== 0 && Number.isFinite(value) ? [name] : []),\n    ...(typeof value === "string" || typeof value === "number" ? [name + "=" + encodeURIComponent(String(value))] : [])\n  ]).join(" ");\n}\n` },
    { path: "angular/projection.ts", content: `import { Directive, ElementRef, inject } from "@angular/core";
@Directive({ selector: "[hnNextProjection]", standalone: true })
export class HtmlNextProjection {
  owners: readonly string[] = [];
  private readonly root = inject<ElementRef<Element>>(ElementRef).nativeElement;
  private observer: MutationObserver | undefined;
  private stamp(parent: Element): void {
    for (const child of Array.from(parent.children)) {
      if (child.hasAttribute("data-slotted")) continue;
      if (!this.owners.includes(child.getAttribute("data-hn-owner") ?? "")) { child.setAttribute("data-slotted", ""); continue; }
      if (!child.hasAttribute("data-hn")) this.stamp(child);
    }
  }
  ngAfterViewInit(): void {
    this.stamp(this.root);
    if (typeof MutationObserver !== "undefined") {
      this.observer = new MutationObserver(() => this.stamp(this.root));
      this.observer.observe(this.root, { childList: true, subtree: true });
    }
  }
  ngOnDestroy(): void { this.observer?.disconnect(); }
}\n` },
    { path: "angular/context.ts", content: `import { InjectionToken, type Signal } from "@angular/core";\nconst key = Symbol.for("@nextwebwg/html-next.angular.context");
const existing: unknown = Reflect.get(globalThis, key);
const tokens: Map<string, InjectionToken<Signal<any>>> = existing instanceof Map ? existing : new Map();
if (existing === undefined) Reflect.set(globalThis, key, tokens);
export function contextToken(name: string): InjectionToken<Signal<any>> {\n  let token = tokens.get(name); if (token === undefined) { token = new InjectionToken<Signal<any>>(name); tokens.set(name, token); } return token;\n}\n` },
    { path: "angular/events.ts", content: `${nativeEventsModule(version, true).replace('from "./props"', 'from "./state"')}\nimport { Directive, ElementRef, Input, inject } from "@angular/core";\n@Directive({ selector: "[hnNextEvents]", standalone: true })\nexport class HtmlNextEvents {\n  @Input("hnNextEvents") bindings: readonly NativeBinding[] = [];\n  private readonly element = inject<ElementRef<Element>>(ElementRef).nativeElement;\n  private key = "";\n  private stop: (() => void) | undefined;\n  ngOnChanges(): void {\n    const key = JSON.stringify(this.bindings.map(binding => [binding.type, binding.modifiers]));\n    if (key === this.key) return; this.key = key; this.stop?.();\n    this.stop = attachNativeEvents(this.element, this.bindings.map((binding, index) => ({ ...binding, handler: event => this.bindings[index]!.handler(event) })));\n  }\n  ngOnDestroy(): void { this.stop?.(); }\n}\n` },
  ].filter(artifact => helpers === undefined || helpers.has(artifact.path.slice("angular/".length, -".ts".length)));
}
