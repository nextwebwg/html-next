import { ITERATION_INDEX } from "../expression.js";
import { attributeNamespace } from "../dom-attributes.js";
import { namespacedAttributeSource } from "./shared.js";
import { referenceContext, referenceType, withReferenceTypes } from "./reference-types.js";
import { TypeScriptLowering } from "./typed-lowering.js";
/** Standalone Angular components on their declared native hosts. Root delegation is composed at build time. */
import { kebabCase, propAttribute, componentName as pascalCase } from "../names.js";
import { parseDuration } from "../duration.js";
import { fail } from "../diagnostics.js";
import type { CompiledExpression } from "../expression.js";
import { componentStateNames, compileComponentGraphStylesForConversion, VUE_ROOT_ATTRIBUTE } from "../component-styles-build.js";
import { stateAttribute } from "../component-styles.js";
import type { ComponentDefinition, ElementNode, HandlerDeclaration, TemplateNode } from "../template.js";
import { definitionMayInvokeComponents, elementMatchRoot, iteratedRefNames } from "../template.js";
import { declarationTypeNode, normalizeType, parseTypedValue, typeScriptType, type TypeNode } from "../type-system.js";
import { headEntriesSource, headScriptsSource, headHelperArtifact } from "./head-target.js";
import { targetComponent, type TargetRequest } from "./backend.js";
import { frameworkRequestSource } from "./requests-target.js";
import { requestsArtifact } from "./request-host-source.js";
import { angularHtmlArtifact, angularHtmlFragmentTemplate } from "./angular-html.js";
import { angularDataArtifact } from "./angular-data.js";
import { angularHostArtifact } from "./angular-host.js";
import { angularBindingsArtifact } from "./angular-bindings.js";
import { angularControlsRendererArtifact } from "./angular-controls-renderer.js";
import { angularNativeViewArtifact, angularNativeViewSource } from "./angular-native-view.js";
import { DOM_INTERFACES } from "../generated/dom-properties.js";
import { resolveDomProperty } from "../platform.js";
import { angularValidityArtifact } from "./angular-validity.js";
import { angularControlArtifact } from "./angular-control.js";
import { invocationValue } from "../prop-values.js";
import { declaredStateLiteral, literalInitial, revertSource, withRevert, publishedStates } from "./state-roots.js";
import { expressionHelpersSource, AUTHORED_CHECK_SOURCE, inputScope, present, typeOf, UNKNOWN, type Scope, type Static } from "./vue-lowering.js";
import { escapeHtml, isVoidElement, isNativeBooleanAttribute, objectKey as propertyKey, quote, propTypeSource, propValueIsNullable, selectorGenerics, dependentPropTypeSource, slotPropsType, slotPropValueSource, slotPropDefaultSource, svgAttributeName } from "./shared.js";
import type { GeneratedArtifact } from "../generate.js";
import { typedPropsModule } from "./vue-props.js";
import { NATIVE_PATH_WRITE_SOURCE } from "./react-control.js";
import { nativeEventsModule } from "./react-events.js";
import { DECLARED_EVENT_TYPE_SOURCE } from "./shared-generated.js";

/** JavaScript literals retain authored __proto__ fields as own data properties. */
function sourceValue(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space)?.replaceAll('"__proto__":', '["__proto__"]:') ?? "undefined";
}

function angularPropContract(definition: ComponentDefinition) {
  return { props: Object.fromEntries(Object.entries(definition.contract.props).map(([name, prop]) => [name, { type: prop.select === undefined ? normalizeType(prop.type) : { kind: "union", members: prop.select.options.map(item => item.type) }, ...(prop.select === undefined ? {} : { select: prop.select }), required: prop.required, ...Object.fromEntries(["values", "pattern", "min", "max", "minLength", "maxLength"].flatMap(key => prop[key as keyof typeof prop] === undefined ? [] : [[key, prop[key as keyof typeof prop]]])) }])) };
}

export interface AngularOptions {
  readonly preparationForTag?: (tag: string) => { readonly source: string } | undefined;
  readonly publicState?: boolean;
  readonly guardNestedDepth?: boolean;
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


function unsupported(message: string): never { return fail("HT018", `Angular conversion: ${message}`); }

/** Follow a delegated root without introducing an Angular host wrapper. */
export function angularHostTag(definition: ComponentDefinition, graph: ReadonlyMap<string, ComponentDefinition>, seen = new Set<string>()): string {
  const tag = definition.contract.tag;
  if (seen.has(tag)) return unsupported(`root delegation cycles at <${tag}>.`);
  seen.add(tag);
  if (definition.template.name === "template" || definition.template.flow !== undefined && definition.template.flow.kind !== "with") return "ng-template";
  const child = graph.get(definition.template.name);
  return child === undefined ? definition.template.name : angularHostTag(child, graph, seen);
}

export interface AngularConversion {
  readonly component: string;
  readonly helpers: ReadonlySet<string>;
}

/** The accepted children other templates render into a parent's content join its list once its view places them. */
const ACCEPTED_CHECK = "ngAfterViewChecked(): void { this.hnAccepted.check(); }";

export function generateAngularConversion(definition: ComponentDefinition, version: string, options: AngularOptions = {}): AngularConversion {
  const graph = new Map([...options.componentGraph ?? [], [definition.contract.tag, definition] as const]);
  const native = angularHostTag(definition, graph);
  const nativeView = native === "ng-template";
  const generics = selectorGenerics(definition.contract.props);
  const parameters = new Map(generics.map(item => [item.from, item.parameter]));
  const lowering = new TypeScriptLowering();
  const fields: string[] = [];
  const methods: string[] = [];
  const host: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, { [VUE_ROOT_ATTRIBUTE]: "" });
  const rootEvents: string[] = [];
  const validityModels: string[] = [];
  const rootControls: string[] = [];
  const rootProperties: string[] = [];
  let rootHtml: string | undefined;
  const imports = new Map<string, string>();
  const controllerImports = new Map<string, string>();
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
  // Columns as markup (components#slot-accepts-as): the tags some slot in the build accepts. An accepted
  // child gives its parent an entry and the templates for the slots it declares but does not render itself.
  // ponytail: so a column converted in a build without an accepting table has no entry, and a table built
  // elsewhere cannot list it. Reading it from the table would need the column's input fields by reflection,
  // its prop resolution again in the table, a shared slot-template directive matched to each column, and
  // document-order sorting across tags; convert the column with its table until a library needs otherwise.
  const acceptedTags = new Set([...graph.values()].flatMap(item => Object.values(item.contract.slots ?? {}).flatMap(slot => slot.accepts ?? [])));
  const placedSlots = (child: ComponentDefinition): string[] => !acceptedTags.has(child.contract.tag) ? []
    : Object.keys(child.contract.slots ?? {}).filter(name => !(child.slots ?? []).some(own => (own.name ?? "") === name));
  const childProviders: string[] = [];
  let ownNames: Names | undefined;
  const chain: ComponentDefinition[] = [];
  const models: { definition: ComponentDefinition; names: Names; raw: Map<string, string>; inputs: Map<string, string>; types: Map<string, unknown>; source?: string; requests: readonly TargetRequest[]; responders: Map<string, readonly [string, string]>; readNames: string[] }[] = [];
  const providers: string[] = [];
  if (options.guardNestedDepth) {
    helpers.add("depth");
    providers.push("{ provide: NESTED_DEPTH, useFactory: () => (inject(NESTED_DEPTH, { skipSelf: true, optional: true }) ?? -1) + 1 }");
    fields.push(`private readonly hnDepth = checkNestedDepth(inject(NESTED_DEPTH), ${definitionMayInvokeComponents(definition) ? 32 : 33});`);
  }
  const headModels: string[] = [];
  const contexts = new Map<string, string>();
  helpers.add("state");
  fields.push('readonly hnInputStates = input<Record<string, InputStatus>>({});');
  let serial = 0;
  const field = () => `hn${serial++}`;
  const helper = (name: string): void => { helpers.add(name); };
  const expression = (code: string, names: Names, hostExpression = false, tracking = false): string => {
    const name = field();
    if (hostExpression) {
      const kept = field(); fields.push(`private ${kept}: any;`);
      fields.push(`readonly ${name} = computed(() => { const value: unknown = ${code}; if (${lowering.use("acceptsBindingResult")}(value) && (typeof value !== "number" || Number.isFinite(value))) this.${kept} = value; return this.${kept}; });`);
    } else methods.push(`${name}(${names.locals.map(local => `${local}: any`).join(", ")}): any { return ${code}; }`);
    const call = `${nativeView && !hostExpression ? "hnController." : ""}${name}(${names.locals.join(", ")})`;
    if (hostExpression || tracking) return call;
    helper("value");
    return `${call} | hnNextValue`;
  };
  const value = (plan: CompiledExpression | undefined, names: Names): string => {
    if (plan === undefined) return unsupported("a parsed expression is required.");
    return lowering.value(plan.ast, names);
  };
  const localScope = (names: Names, values: readonly (readonly [string, string, TypeNode | undefined])[]): Names => withReferenceTypes({
    ...names, locals: [...names.locals, ...values.map(([name]) => name)],
    code: new Map([...names.code, ...values.map(([name, code]) => [name, code] as const)]),
    types: new Map([...names.types, ...values.map(([name, , type]) => [name, type === undefined ? UNKNOWN : present(type)] as const)]),
  }, values.map(([name, , type]) => [name, type]));
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
      const structural = (node: TemplateNode): boolean => node.kind === "element"
        ? node.ref === name && graph.has(node.name) && angularHostTag(graph.get(node.name)!, graph) === "ng-template" || node.children.some(structural)
        : node.kind === "slot" && (node.fallback?.some(structural) ?? false);
      if (!root && structural(graph.get(owner)!.template)) {
        fields.push(`readonly ${id}Views = viewChildren<unknown, ViewContainerRef>(${quote(id)}, { read: ViewContainerRef });`);
        fields.push(`readonly ${id} = (): ElementRef<Element>[] => this.${id}Views().flatMap(container => {
          const anchor = container.element.nativeElement as Node;
          const nodes = anchor.nodeType === 1 ? [anchor] : Array.from({ length: container.length }, (_, index) => (container.get(index) as EmbeddedViewRef<unknown>).rootNodes as Node[]).flat();
          return nodes.filter((node): node is Element => node.nodeType === 1).map(node => new ElementRef(node));
        });`);
      } else fields.push(root ? `readonly ${id} = () => [this.hnRoot];` : `readonly ${id} = viewChildren<unknown, ElementRef<Element>>(${quote(id)}, { read: ElementRef });`);
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
    const inputStatuses: string[] = [];
    const nativeAttributes: string[] = [];
    const namespacedAttributes: string[] = [];
    const childView = child !== undefined && angularHostTag(child, graph) === "ng-template";
    if (childView) nativeAttributes.push(`${quote("data-hn-owner")}: ${quote(names.definition.contract.tag)}`);
    if (node.attributes.filter(attribute => attribute.kind === "attribute" && attribute.twoWay).length > 1) return unsupported("multiple two-way control bindings on one element require independent native control ownership.");
    const put = (key: string, source: string) => { if (root) {
      const previous = host[key];
      host[key] = previous !== undefined && (key === "class" || key === "style") ? `${source}${key === "class" ? " " : ";"}${previous}` : source;
    } else attributes.push(`${key}="${escapeHtml(source)}"`); };
    for (const attribute of node.attributes) {
      if (!root && child === undefined && (attribute.kind === "literal" || attribute.kind === "attribute" && attribute.target === undefined && !attribute.twoWay) && attributeNamespace(attribute.name) !== undefined) {
        helper("attributes");
        const code = attribute.kind === "literal" ? quote(attribute.value) : lowering.attribute(attribute.expressionPlan!.ast, names, attribute.name);
        namespacedAttributes.push(namespacedAttributeSource(attribute.name, code));
        continue;
      }
      if (attribute.kind === "directive") continue;
      if (attribute.kind === "literal") {
        const inputName = child === undefined ? undefined : receivingProp(child, attribute.name);
        const contract = inputName === undefined ? undefined : child!.contract.props[inputName];
        if (inputName !== undefined) {
          const parsed = contract === undefined ? undefined : parseTypedValue(attribute.value, contract.type, "$", "html");
          put(`[${inputName}]`, expression(parsed?.ok ? sourceValue(parsed.value) : quote(attribute.value), names, root));
        } else if (childView) {
          nativeAttributes.push(`${quote(attribute.name)}: ${isNativeBooleanAttribute(attribute.name) ? "true" : quote(attribute.value)}`);
          // Angular selects named projection at the template anchor before its native view exists.
          if (attribute.name === "slot") put("slot", attribute.value);
        }
        else put(attribute.name, attribute.value);
      }
      else {
        const key = attribute.kind === "property" ? attribute.key : attribute.target === undefined ? svgAttributeName(attribute.name) : attribute.name;
        const componentInput = child === undefined ? undefined : receivingProp(child, key);
        if (componentInput !== undefined && child!.contract.props[componentInput] !== undefined) {
          const observed = value(attribute.expressionPlan, inputScope(names, name => names.statuses.get(name)));
          inputStatuses.push(`${quote(componentInput)}: evaluateInput(() => ${observed}).status`);
        }
        const code = attribute.kind === "property" || componentInput !== undefined ? value(attribute.expressionPlan, names)
          : lowering.attribute(attribute.expressionPlan!.ast, names, attribute.name);
        if (attribute.kind === "attribute" && attribute.twoWay) {
          if (child !== undefined) return unsupported("two-way component inputs require an explicit component model contract.");
          helper("control"); helper("state");
          const generic = !(["input", "textarea", "select"].includes(node.name) && (attribute.name === "value" || node.name === "input" && attribute.name === "checked"));
          const read = value(attribute.expressionPlan, names);
          const attributeScope = { ...names, code: new Map([...names.code, ["hnBound", "hnBound"]]), types: new Map([...names.types, ["hnBound", UNKNOWN]]) };
          const boundValue = generic ? `((hnBound: unknown) => ${lowering.attribute({ kind: "id", name: "hnBound" }, attributeScope, attribute.name)})(${read})` : read;
          const defaults: { value?: string; checked?: boolean; options?: boolean[] } = {};
          for (const literal of node.attributes) if (literal.kind === "literal") {
            if (literal.name === "value") defaults.value = literal.value;
            if (literal.name === "checked") defaults.checked = true;
          }
          if (node.name === "select" && !generic) {
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
          const binding = `{ name: ${quote(attribute.name)}, ${generic ? "generic: true, " : ""}value: ${boundValue}, defaults: ${sourceValue(defaults)}, update: (next: unknown) => { ${update} return ${read}; } }`;
          if (root) rootControls.push(binding);
          else controls.push(binding);
          continue;
        }
        const destination = attribute.kind === "attribute" && attribute.target !== undefined ? `${attribute.target}.${key}`
          : componentInput ?? (attribute.kind === "property" ? key : `attr.${key}`);
        let lowered = attribute.kind === "attribute" && attribute.target === "class" ? lowering.condition(attribute.expressionPlan!.ast, names)
          : attribute.kind === "attribute" && attribute.target === "style" ? lowering.text(attribute.expressionPlan!.ast, names) : code;
        if (attribute.kind === "attribute" && attribute.target === undefined && componentInput === undefined && isNativeBooleanAttribute(key)) {
          helper("state"); lowered = `nativeBooleanAttribute(${lowered})`;
        }
        if (root && attribute.kind === "property" && componentInput === undefined && resolveDomProperty(native, key) === undefined) {
          rootProperties.push(`Reflect.set(this.hnRoot.nativeElement, ${quote(key)}, ${lowered});`);
          continue;
        }
        if (childView && componentInput === undefined) nativeAttributes.push(`${quote(attribute.kind === "property" ? `.${key}` : destination.replace(/^attr\./, ""))}: ${lowered}`);
        else put(`[${destination}]`, expression(lowered, names, root));
      }
    }
    if (namespacedAttributes.length > 0) attributes.push(`[hnNextNamespaces]="${expression(`[${namespacedAttributes.join(", ")}]`, names)}"`);
    if (inputStatuses.length > 0) attributes.push(`[hnInputStates]="${expression(`{ ${inputStatuses.join(", ")} }`, names)}"`);
    if (nativeAttributes.length > 0) attributes.push(`[hnAttributes]="${expression(`{ ${nativeAttributes.join(", ")} }`, names)}"`);
    if (controls.length > 0) attributes.push(`[hnNextControl]="${expression(`[${controls.join(", ")}]`, names)}"`);
    if (node.ref !== undefined) {
      const id = ref(node.ref, root, names.definition.contract.tag);
      if (!root) attributes.push(`#${id}`);
    }
    const listeners = events(node, names);
    if (listeners.length > 0) {
      if (root) rootEvents.push(...listeners);
      else attributes.push(`[${childView ? "hnEvents" : "hnNextEvents"}]="${expression(`[${listeners.join(", ")}]`, names)}"`);
    }
    return attributes;
  };
  const htmlBinding = (node: ElementNode, plan: CompiledExpression | undefined, names: Names): string => {
    if (node.children.some(child => child.kind !== "text" || child.expressionPlan !== undefined || child.segments !== undefined)) return unsupported("$html regions with authored child views are not supported; use an empty native element for sanitized markup.");
    helper("html");
    return `{ value: ${value(plan, names)}, owner: ${quote(names.definition.contract.tag)}, fallback: ${quote(node.children.map(child => child.kind === "text" ? child.value : "").join(""))} }`;
  };
  /** Warns once when the component is created, as live warns while it renders. */
  const warn = (key: string, message: string): void => {
    helper("state");
    fields.push(`private readonly ${field()} = warnUnless(false, ${quote(key)}, ${quote(message)});`);
  };
  /** Content for a slot with `accepts` keeps only accepted components, through structural templates; the rest is left out with a warning. */
  const accepted = (child: ComponentDefinition, projected: TemplateNode): TemplateNode | undefined => {
    if (projected.kind === "slot") return projected;
    const slot = projected.kind === "element" ? projected.attributes.find(attribute => attribute.kind === "literal" && attribute.name === "slot") : undefined;
    const name = slot?.kind === "literal" ? slot.value : "";
    const accepts = child.contract.slots?.[name]?.accepts;
    if (accepts === undefined) return projected;
    const quoted = accepts.map(tag => `\`${tag}\``);
    const named = `\`${child.contract.tag}\`'s ${name === "" ? "default slot" : `\`${name}\` slot`}`;
    const listed = `${named} accepts ${quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`}`;
    if (projected.kind === "text") {
      if (projected.expressionPlan === undefined && projected.segments === undefined && !/[^\t\n\f\r ]/.test(projected.value)) return projected;
      warn(`accepts:${child.contract.tag}:${name}:#text`, `${listed}; this text is left out.`);
      return undefined;
    }
    if (projected.name === "template" && slot === undefined) return { ...projected, children: projected.children.flatMap(item => accepted(child, item) ?? []) };
    if (accepts.includes(projected.name)) return projected;
    const seen = new Set<string>();
    let delegated = graph.get(projected.name);
    while (delegated !== undefined && !accepts.includes(delegated.template.name) && !seen.has(delegated.contract.tag)) { seen.add(delegated.contract.tag); delegated = graph.get(delegated.template.name); }
    if (delegated !== undefined && !accepts.includes(delegated.template.name)) delegated = undefined;
    warn(`accepts:${child.contract.tag}:${name}:${projected.name}`, delegated === undefined ? `${listed}; this \`<${projected.name}>\` is left out.`
      : `\`<${projected.name}>\` is a preset of \`${delegated.template.name}\`, which ${named} accepts; a preset among accepted children is not supported yet, so it is left out.`);
    return undefined;
  };
  const renderChildren = (nodes: readonly TemplateNode[], names: Names, projection?: Projection, rootView = false): string => {
    let result = "";
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (node.kind === "element" && node.flow?.kind === "match") {
        const flow = node.flow;
        const alias = `local${serial++}`;
        const local = flow.alias === undefined ? names : localScope(names, [[alias, alias, undefined]]);
        const matchNames = flow.alias === undefined ? local : withReferenceTypes({ ...local, code: new Map([...local.code, [flow.alias, alias]]) }, [[flow.alias, flow.expressionPlan === undefined ? undefined : referenceType(flow.expressionPlan.ast, names)]]);
        const region = `hnRegion${serial++}`;
        if (flow.alias !== undefined) { helper("region"); helper("value"); }
        const prefix = flow.alias === undefined ? "" : `@let ${region} = ${expression(value(flow.expressionPlan, names), names, false, true)} | hnNextRegion;@if (${region}.ready) {@let ${alias} = ${region}.value;`;
        let branches = "";
        for (const arm of node.children) {
          if (arm.kind !== "element" || arm.flow?.kind !== "when" && arm.flow?.kind !== "else") return unsupported("match arms must be conditional elements.");
          const markup = render({ ...arm, flow: undefined } as unknown as ElementNode, matchNames, projection, rootView);
          if (arm.flow.kind === "else") branches += ` @else {${markup}}`;
          else branches += `${branches === "" ? "@if" : " @else if"} (${expression(lowering.condition(arm.flow.testPlan!.ast, matchNames), matchNames)}) {${markup}}`;
        }
        const content = prefix + branches + (flow.alias === undefined ? "" : "}");
        result += node.name === "template" ? content : render({ ...elementMatchRoot(node), children: [{ kind: "text", value: "" }], flow: undefined } as unknown as ElementNode, names, projection).replace("></", `>${content}</`);
      } else result += render(node, names, projection, rootView);
    }
    return result;
  };
  const render = (node: TemplateNode, names: Names, projection?: Projection, rootView = false): string => {
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
      if (node.of !== undefined) {
        // `<slot of>` places an accepted child's slot: the consumer's template for it, with this outlet's props, or the fallback.
        const accepts = Object.values(names.definition.contract.slots ?? {}).find(item => item.as === node.of!.list)?.accepts ?? [];
        // The props each accepted tag's template receives, as live's `childSlotProps` checks them against that
        // tag's slot declaration: a static prop converts by its declared type, a bound one is checked in full,
        // null, rejected and left-out props take the declared default, and undeclared or missing required props warn.
        const file = options.definitionURL?.(names.definition.contract.tag) ?? names.definition.source.file;
        const owner = { source: { file }, contract: names.definition.contract };
        const read = (prop: NonNullable<typeof node.props>[number]): string => `finiteResult(${value(prop.expressionPlan, names)})`;
        const shapes = accepts.flatMap(tag => {
          const child = graph.get(tag);
          if (child === undefined) return [];
          const props = child.contract.slots?.[slot]?.props ?? {};
          const outlet = `<slot of name="${slot}">`;
          const warnings: string[] = [];
          const warnOf = (prop: string, message: string): void => { warnings.push(`warnUnless(false, ${quote(`${file}#${tag}:of:${slot}:${prop}`)}, ${quote(`${file}: HR007: ${message}`)})`); };
          const entries = (node.props ?? []).map(prop => {
            const contract = props[prop.name];
            if (contract === undefined) {
              warnOf(prop.name, `${outlet} gives prop \`${prop.name}\`, which \`${tag}\`'s slot \`${slot}\` does not declare.`);
              return `${propertyKey(prop.name)}: ${read(prop)}`;
            }
            if (prop.raw !== undefined) return `${propertyKey(prop.name)}: ${sourceValue(invocationValue(contract, prop.raw, "html", true) ?? null)}`;
            const type = normalizeType(contract.type);
            const check = slotPropValueSource(owner, slot === "" ? undefined : slot, { name: prop.name, ...type.kind === "terminal" && type.name === "unknown" ? {} : { type: contract.type }, ...contract.default === undefined ? {} : { default: contract.default } }, true);
            return `${propertyKey(prop.name)}: ${check === undefined ? read(prop) : `(${check})(${read(prop)})`}`;
          });
          for (const [prop, contract] of Object.entries(props)) {
            if ((node.props ?? []).some(given => given.name === prop)) continue;
            if (contract.required) warnOf(prop, `${outlet} must give prop \`${prop}\`, which \`${tag}\`'s slot \`${slot}\` declares as required.`);
            if (contract.default !== undefined) entries.push(`${propertyKey(prop)}: ${sourceValue(contract.default)}`);
          }
          return entries.length === 0 && warnings.length === 0 ? [] : [[tag, `(${[...warnings, `{ ${entries.join(", ")} }`].join(", ")})`] as const];
        });
        const entry = value(node.of.expressionPlan, names);
        const given = shapes.length === 0 ? (node.props?.length ? `{ ${node.props.map(prop => `${propertyKey(prop.name)}: ${read(prop)}`).join(", ")} }` : undefined)
          : shapes.length === 1 && accepts.length === 1 ? shapes[0]![1]
          : `((tag: string | undefined) => ${shapes.map(([tag, shape]) => `tag === ${quote(tag)} ? ${shape} : `).join("")}{})(childTag(${entry}))`;
        const plainWarning = (node.props?.length ?? 0) === 0 ? "" : ` hnNextChildSlotPlainWarning="${escapeHtml(`${file}: HR007: \`${slot}\` has props, so its content is a \`<template slot="${slot}">\`.`)}"`;
        helper("children"); helper("slots"); helper("state"); helper("value");
        const fallback = `hnFallback${serial++}`;
        return `<ng-template #${fallback}>${renderChildren(node.fallback ?? [], names, projection)}</ng-template><ng-container [hnNextChildSlot]="${expression(`childSlot(${entry}, ${quote(slot)})`, names, false, true)}" [hnNextChildSlotFallback]="${fallback}"${given === undefined ? "" : ` [hnNextChildSlotContext]="${expression(given, names, false, true)} | hnNextSlotValues"`}${plainWarning}></ng-container>`;
      }
      if (projection !== undefined) {
        const selected = projection.nodes.filter(child => (child.kind === "element" ? child.attributes.find((attribute): attribute is import("../template.js").LiteralAttribute => attribute.kind === "literal" && attribute.name === "slot")?.value : undefined) === (slot === "" ? undefined : slot));
        if (selected.length > 0) {
          if (!scoped) return renderChildren(selected, projection.names, projection.parent);
          const carrier = selected.find((child): child is ElementNode => child.kind === "element" && child.name === "template");
          if (carrier !== undefined) {
            const locals = values.map(([name, source, type]) => ({ name, source, type, id: `local${serial++}` }));
            const scopedNames = localScope(projection.names, locals.map(item => [item.id, item.id, item.type === undefined ? undefined : normalizeType(item.type)]));
            const code = new Map(scopedNames.code); locals.forEach(item => code.set(item.name, item.id));
            return locals.map(item => `@let ${item.id} = ${expression(item.source, names)};`).join("") + renderChildren(carrier.children, withReferenceTypes({ ...scopedNames, code }, locals.map(item => [item.name, undefined])), projection.parent);
          }
        }
      }
      if (scoped) {
        const selected = outlet(slot, names.definition); helper("slots"); helper("state"); helper("value");
        const defaults = field();
        fields.push(`readonly ${defaults} = { ${(node.props ?? []).map(prop => `${propertyKey(prop.name)}: ${slotPropDefaultSource(prop)}`).join(", ")} };`);
        const context = `${expression(`{ ${values.map(([name, source]) => `${propertyKey(name)}: ${source}`).join(", ")} }`, names, false, true)} | hnNextSlotValues: ${nativeView ? "hnController." : ""}${defaults}`;
        return `@if (${nativeView ? "hnController." : ""}${selected.query}(); as supplied) {<ng-container [ngTemplateOutlet]="supplied.template" [ngTemplateOutletContext]="${context}"></ng-container>} @else {${renderChildren(node.fallback ?? [], names, projection)}}`;
      }
      if (nativeView) {
        const fallback = node.fallback?.length ? `hnFallback${serial++}` : undefined;
        return `${fallback ? `<ng-template #${fallback}>${renderChildren(node.fallback!, names, projection)}</ng-template>` : ""}<ng-container [hnNextSlot]="hnController.hnSlotTemplates()[${escapeHtml(quote(slot))}]${slot === "" ? " ?? hnController.hnView.content" : ""}"${fallback ? ` [hnNextSlotFallback]="${fallback}"` : ""} hnNextSlotName="${slot}"></ng-container>`;
      }
      return `<ng-content${slot === "" ? "" : ` select="[slot='${slot}']"`}>${renderChildren(node.fallback ?? [], names, projection)}</ng-content>`;
    }
    if (node.flow !== undefined) {
      const flow = node.flow;
      const plain = { ...node, flow: undefined } as unknown as ElementNode;
      if (flow.kind === "if") return `@if (${expression(lowering.condition(flow.testPlan!.ast, names), names)}) {${render(plain, names, projection, rootView)}}`;
      if (flow.kind === "with") {
        if (flow.binding !== undefined) helper("state");
        helper("value"); helper("region");
        const id = `local${serial++}`;
        const region = `hnRegion${serial++}`;
        const scoped = localScope(names, [[id, id, flow.aliasType]]);
        const code = new Map(scoped.code); code.set(flow.alias, id);
        const types = new Map(scoped.types); types.set(flow.alias, flow.aliasType === undefined ? typeOf(flow.expressionPlan!.ast, names) : present(flow.aliasType));
        return `@let ${region} = ${expression(flow.binding === undefined ? value(flow.expressionPlan, names) : `requireInputStatus(${names.statuses.get(flow.binding.name) ?? "UNRESOLVED_INPUT"}, ${flow.binding.handlesError})`, names, false, true)} | hnNextRegion;@if (${region}.ready) {@let ${id} = ${region}.value;${render(plain, withReferenceTypes({ ...scoped, code, types }, [[flow.alias, flow.binding === undefined ? referenceType(flow.expressionPlan!.ast, names) : undefined]]), projection, rootView)}}`;
      }
      if (flow.kind === "each") {
        const id = `row${serial++}`;
        const retained = `hnList${serial++}`;
        const retainedNames = localScope(names, [[retained, retained, undefined]]);
        const itemType = typeOf(flow.listPlan!.ast, names).type;
        const itemReference = referenceType(flow.listPlan!.ast, names);
        const itemContract = itemReference?.kind === "list" ? itemReference.item : undefined;
        const itemNames = withReferenceTypes({ ...names, code: new Map([...names.code, [flow.item, "item"]]), types: new Map([...names.types, [flow.item, itemType.kind === "list" ? present(itemType.item) : UNKNOWN]]) }, [[flow.item, itemContract]]);
        const list = lowering.list(flow.listPlan!.ast, names, "item", { itemScope: itemNames,
          ...(flow.wherePlan === undefined ? {} : { where: flow.wherePlan.ast }),
          sort: flow.sortKeys?.map(key => `${key.descending ? "-" : ""}${key.path.join(".")}`) ?? [], ...(flow.limitPlan === undefined ? {} : { limit: flow.limitPlan.ast }) }, `((${retained} ?? []) as any[])`);
        const scoped = localScope(names, [[id, id, undefined]]);
        const code = new Map(scoped.code); code.set(flow.item, `${id}.item`); code.set(ITERATION_INDEX, `${id}.index`);
        if (flow.index !== undefined) code.set(flow.index, `${id}.index`);
        const indexType: Static = { type: { kind: "terminal", name: "number" }, nullable: false };
        const indexTypes = [[ITERATION_INDEX, indexType], ...flow.index === undefined ? [] : [[flow.index, indexType] as const]] as const;
        const loopNames = withReferenceTypes({ ...scoped, code, types: new Map([...scoped.types, [flow.item, itemType.kind === "list" ? present(itemType.item) : UNKNOWN], ...indexTypes]) }, [[flow.item, itemContract], [ITERATION_INDEX, undefined], ...(flow.index === undefined ? [] : [[flow.index, undefined] as const])]);
        const keyScope = withReferenceTypes({ ...itemNames, types: new Map([...itemNames.types, ...indexTypes]), code: new Map([...itemNames.code, [ITERATION_INDEX, "index"], ...(flow.index === undefined ? [] : [[flow.index, "index"] as const])]) }, [[ITERATION_INDEX, undefined], ...(flow.index === undefined ? [] : [[flow.index, undefined] as const])]);
        const unique = flow.keyPlan === undefined ? list : lowering.uniqueKeys(list, `(item: any, index: number) => ${value(flow.keyPlan, keyScope)}`);
        const rows = lowering.eachRows(unique);
        const keyedRows = flow.keyPlan === undefined ? rows : `${rows}.map((${id}: any) => ({ ...${id}, hnKey: ${value(flow.keyPlan, loopNames)} }))`;
        return `@let ${retained} = ${expression(value(flow.listPlan, names), names)};@for (${id} of ${expression(keyedRows, retainedNames)}; track ${id}.${flow.keyPlan === undefined ? "index" : "hnKey"}) {${render(plain, loopNames, projection)}}`;
      }
      if (flow.kind !== "match") return unsupported(`orphan ${flow.kind} directive.`);
    }
    if (node.name === "template") {
      const content = node.attributes.find(attribute => attribute.kind === "directive");
      if (content?.kind === "directive") {
        if (content.name === "html") {
          helper("html"); helper("html-fragment"); helper("slots");
          return `<ng-template [hnNextHtmlFragment]="${expression(htmlBinding(node, content.expressionPlan, names), names)}" let-hnNodes><ng-container [ngTemplateOutlet]="hnHtmlNodes" [ngTemplateOutletContext]="{ $implicit: hnNodes }"></ng-container></ng-template>`;
        }
        return `{{ ${expression(lowering.text(content.expressionPlan!.ast, names), names)} }}`;
      }
      return renderChildren(node.children, names, projection, rootView);
    }
    const child = graph.get(node.name);
    let tag = node.name;
    const attributes = bindings(node, names, false, child);
    if (rootView) {
      const authored = node.attributes.flatMap(attribute => attribute.kind === "directive" ? []
        : attribute.kind === "literal" && attribute.name === "class" ? attribute.value.split(/\s+/).filter(Boolean).map(token => `class.${token}`)
        : [attribute.kind === "property" ? `.${attribute.key}` : attribute.kind === "attribute" && attribute.target !== undefined ? `${attribute.target}.${attribute.name}` : attribute.name]);
      attributes.push(`[hn${definition.contract.name}Root]="hnController"`, `[hn${definition.contract.name}RootAuthored]="${escapeHtml(JSON.stringify(authored))}"`);
    }
    if (child !== undefined) {
      tag = angularHostTag(child, graph);
      attributes.unshift(child.contract.tag);
      imports.set(child.contract.tag, child.contract.name);
    }
    const directive = node.attributes.find(attribute => attribute.kind === "directive");
    if (directive?.kind === "directive" && directive.name === "html") attributes.push(`[hnNextHtml]="${expression(htmlBinding(node, directive.expressionPlan, names), names)}"`);
    let templates = "";
    const project = (): string => {
      if (child === undefined) return renderChildren(node.children, names, projection);
      const structural = tag === "ng-template";
      const slots = new Map<string, string>();
      const slotDirective = (name: string): string => {
        const directive = `${child.contract.name}${pascalCase(name || "default")}Slot`;
        const imported = slotImports.get(child.contract.tag) ?? new Set(); imported.add(directive); slotImports.set(child.contract.tag, imported);
        return directive;
      };
      const content = node.children.flatMap(projected => accepted(child, projected) ?? []).map(projected => {
        const slot = projected.kind !== "element" ? undefined : projected.attributes.find(attribute => attribute.kind === "literal" && attribute.name === "slot");
        const contract = slot?.kind === "literal" ? child.contract.slots?.[slot.value] : undefined;
        // A `$match` among a component's children renders its arms as one region.
        if (slot?.kind !== "literal" || projected.kind !== "element") return renderChildren([projected], names, projection);
        if (contract !== undefined && acceptedTags.has(child.contract.tag) && !structural) {
          // An accepted child's slot its parent places: scoped content must be a template, and plain
          // content for a slot the child does not render itself is a template its parent's `<slot of>` renders.
          if (Object.keys(contract.props).length > 0 && projected.name !== "template") {
            warn(`of:${child.contract.tag}:${slot.value}:plain`, `\`${slot.value}\` has props, so its content is a \`<template slot="${slot.value}">\`.`);
            return "";
          }
          if (Object.keys(contract.props).length === 0 && placedSlots(child).includes(slot.value)) {
            slotDirective(slot.value);
            if (projected.name === "template") return `<ng-template ${child.contract.tag}-${slot.value || "default"}>${renderChildren(projected.children, names, projection)}</ng-template>`;
            helper("children");
            return `<ng-template ${child.contract.tag}-${slot.value || "default"} hnNextPlain>${render(projected, names, projection)}</ng-template>`;
          }
        }
        if (structural) {
          // Group all siblings for a named slot in one consumer-owned template.
          if (!slots.has(slot.value)) slots.set(slot.value, `hnSupplied${serial++}`);
          return "";
        }
        if (projected.name !== "template") return render(projected, names, projection);
        const rendered = (child.slots ?? []).find(outlet => (outlet.name ?? "") === slot.value);
        const exposed = contract === undefined ? {} : rendered === undefined ? contract.props
          : Object.fromEntries((rendered.props ?? []).map(name => [name, contract.props[name]!]));
        if (Object.keys(exposed).length === 0) return `<ng-container ngProjectAs="[slot='${slot.value}']">${renderChildren(projected.children, names, projection)}</ng-container>`;
        slotDirective(slot.value);
        const locals = Object.entries(exposed).map(([name, prop]) => ({ name, type: normalizeType(prop.type), id: `local${serial++}` }));
        const scoped = localScope(names, locals.map(item => [item.id, item.id, item.type]));
        const code = new Map(scoped.code); locals.forEach(item => code.set(item.name, item.id));
        return `<ng-template ${child.contract.tag}-${slot.value || "default"} ${locals.map(item => `let-${item.id}="${item.name}"`).join(" ")}>${renderChildren(projected.children, withReferenceTypes({ ...scoped, code }, locals.map(item => [item.name, undefined])), projection)}</ng-template>`;
      }).join("");
      for (const [name, ref] of slots) {
        const props = child.contract.slots?.[name]?.props ?? {};
        const locals = Object.entries(props).map(([name, prop]) => ({ name, type: normalizeType(prop.type), id: `local${serial++}` }));
        const scoped = localScope(names, locals.map(item => [item.id, item.id, item.type]));
        const code = new Map(scoped.code); locals.forEach(item => code.set(item.name, item.id));
        const selected = node.children.filter(projected => projected.kind === "element" && projected.attributes.some(attr => attr.kind === "literal" && attr.name === "slot" && attr.value === name));
        const directive = `${child.contract.name}${pascalCase(name || "default")}Slot`;
        if (locals.length) {
          const imported = slotImports.get(child.contract.tag) ?? new Set(); imported.add(directive); slotImports.set(child.contract.tag, imported);
        }
        templates += `<ng-template #${ref}${locals.length ? ` ${child.contract.tag}-${name || "default"}` : ""} ${locals.map(item => `let-${item.id}="${item.name}"`).join(" ")}>${selected.map(projected => projected.kind === "element" && projected.name === "template" ? renderChildren(projected.children, withReferenceTypes({ ...scoped, code }, locals.map(item => [item.name, undefined])), projection) : render(projected, { ...scoped, code }, projection)).join("")}</ng-template>`;
      }
      if (slots.size) attributes.push(`[slots]="${escapeHtml(`{ ${[...slots].map(([name, ref]) => `${quote(name)}: ${ref}`).join(", ")} }`)}"`);
      return content;
    };
    const content = directive?.kind === "directive" && directive.name === "html" ? "" : directive?.kind === "directive" ? `{{ ${expression(lowering.text(directive.expressionPlan!.ast, names), names)} }}` : project();
    const open = `<${tag}${attributes.length === 0 ? "" : " " + attributes.join(" ")}>`;
    return templates + (isVoidElement(tag) ? open : `${open}${content}</${tag}>`);
  };
  const compose = (current: ComponentDefinition, supplied?: ReadonlyMap<string, string>, projection?: Projection, suppliedStatuses?: ReadonlyMap<string, string>): string => {
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
    const names: Names = { ...referenceContext(current, options.publicState), code, types, writes, handlers, statuses, locals: [], definition: current };
    if (current === definition) ownNames = names;
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
      const valueType = propValueIsNullable(prop) ? type : `NonNullable<${type}>`;
      const constraints = Object.fromEntries(["values", "pattern", "min", "max", "minLength", "maxLength"].flatMap(key => prop[key as keyof typeof prop] === undefined ? [] : [[key, prop[key as keyof typeof prop]]]));
      const runtimeType = Object.keys(constraints).length === 0 ? normalizeType(prop.type) : { kind: "constrained", base: normalizeType(prop.type), ...constraints };
      const initial = prop.default === undefined ? "undefined" : sourceValue(prop.default);
      propTypes.set(name, prop.select === undefined ? runtimeType : { kind: "union", members: prop.select.options.map(item => item.type) });
      const runtimeSource = prop.select === undefined ? sourceValue(runtimeType) : `selectedPropNode(${code.get(prop.select.from) ?? "undefined"}, ${sourceValue(prop.select.options)})`;
      if (supplied === undefined) fields.push(`readonly ${id} = input<${type} | undefined>(undefined, { alias: ${quote(name)} });`);
      else fields.push(`readonly ${id} = computed<any>(() => ${supplied.get(name) ?? "undefined"});`);
      helper("state");
      fields.push(`readonly ${accepted}: Record<string, unknown> = ${prop.default === undefined ? "{}" : `{ ${propertyKey(name)}: ${initial} }`};`);
      raw.set(name, `this.${id}()`);
      const inheritedStatus = supplied === undefined ? `this.hnInputStates()[${quote(name)}]` : suppliedStatuses?.get(name);
      const ownStatus = `(this.${id}() !== undefined ? READY_INPUT : ${source === undefined ? "" : `this.${source}()[${quote(name)}]?.status ?? `}${initial === "undefined" ? "UNRESOLVED_INPUT" : "READY_INPUT"})`;
      const status = inheritedStatus === undefined ? ownStatus : `(${inheritedStatus} ?? ${ownStatus})`;
      const candidate = `this.${id}() !== undefined ? this.${id}() : ${source === undefined ? initial : `this.${source}()[${quote(name)}] === undefined ? ${initial} : this.${source}()[${quote(name)}]!.value`}`;
      const incoming = `(${candidate}) ?? ${initial === "undefined" ? "null" : initial}`;
      inputs.set(name, incoming);
      fields.push(`readonly ${checked} = computed<${valueType}>(() => ${status}.ready ? checkedInput<${type}>(${incoming}, ${runtimeSource}, ${prop.required}, ${quote(name)}, this.${accepted}) as ${valueType} : ${prop.required ? `(this.${accepted}[${quote(name)}] ?? ${initial === "undefined" ? "null" : initial})` : initial === "undefined" ? "null" : initial} as ${valueType});`);
      statuses.set(name, status);
      contexts.set(`${current.contract.tag}:${name}`, `this.${checked}`);
      code.set(name, `this.${checked}()`); types.set(name, { ...present(normalizeType(prop.type)), nullable: propValueIsNullable(prop), null: propValueIsNullable(prop) });
    }
    // A slot's `as` list: the accepted children a content query finds, in the consumer's content order,
    // complete before this template first renders (and on the server), and those another template renders here.
    for (const [slot, declaration] of Object.entries(current.contract.slots ?? {})) {
      if (declaration.as === undefined) continue;
      if (current !== definition || nativeView) return unsupported(`\`as\` lists on a delegated or template root (<${current.contract.tag}>).`);
      helper("children");
      const accepts = declaration.accepts ?? [];
      const props = new Map<string, TypeNode[]>();
      for (const tag of accepts) for (const [name, prop] of Object.entries(graph.get(tag)?.contract.props ?? {})) props.set(name, [...props.get(name) ?? [], normalizeType(prop.type)]);
      const item: TypeNode = { kind: "object", open: false, fields: [...props].map(([name, members]) => ({ name, optional: true, type: members.length === 1 ? members[0]! : { kind: "union", members } })) };
      const entry = `{ ${[...props].map(([name, members]) => `readonly ${propertyKey(name)}?: ${members.map(typeScriptType).join(" | ")} | null`).join("; ")} }`;
      const id = field();
      if (!methods.includes(ACCEPTED_CHECK)) {
        // One list for every `as` slot, routed by each child's `slot` attribute.
        const tags = [...new Set(Object.values(current.contract.slots ?? {}).flatMap(item => item.as === undefined ? [] : item.accepts ?? []))];
        fields.push("readonly hnAcceptedQuery = contentChildren(ACCEPTED_CHILD);", `readonly hnAccepted = acceptedChildren(this.hnRoot.nativeElement, ${sourceValue(tags)}, this.hnAcceptedQuery);`);
        methods.push(ACCEPTED_CHECK);
      }
      fields.push(`readonly ${id} = computed<readonly ${entry}[]>(() => this.hnAccepted().flatMap(child => child.slot === ${quote(slot)} && ${sourceValue(accepts)}.includes(child.tag) ? [child.entry] : []));`);
      code.set(declaration.as, `this.${id}()`); types.set(declaration.as, present({ kind: "list", item })); statuses.set(declaration.as, "READY_INPUT");
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
      const type = declarationTypeNode(declaration.type, declaration.shape) ?? (declaration.kind === "computed" && declaration.expression !== undefined ? typeOf(declaration.expression.ast, names).type : undefined);
      types.set(declaration.name, type === undefined ? UNKNOWN : { ...present(type), nullable: declaration.kind === "computed" });
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
        methods.push(`${setter}(value: unknown): void { if (value === Symbol.for("html-next.invalid-result") || typeof value === "number" && !Number.isFinite(value)) return; if (acceptsControllerWrite(value, ${sourceValue(type ?? UNKNOWN.type)}, [])) this.${id}.set(value as any); }`);
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
    if (Object.keys(current.contract.props).length > 0) {
      helper("validity");
      validityModels.push(`{ contract: ${sourceValue(angularPropContract(current))}, values: { ${[...inputs].map(([name, value]) => `${propertyKey(name)}: ${value}`).join(", ")} } }`);
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
      // A prop's target describes its first authored binding, which the template already renders.
      // Inspection uses data-* attributes; repeating that target on the host can overwrite the view.
      const reflected = field();
      if (Object.keys(current.contract.props).length > 0) {
        helper("state"); fields.push(`readonly ${reflected} = reflectedInputs();`);
      }
      for (const [name, prop] of Object.entries(current.contract.props)) {
        const attribute = propAttribute(current.contract.tag, name);
        const key = `[attr.${attribute}]`;
        const checked = code.get(name)!;
        const type = normalizeType(prop.type);
        const separator = type.kind === "separated-list" ? quote(type.separator === "space" ? " " : ", ") : "undefined";
        const serialized = `this.${reflected}(${quote(name)}, ${checked}, ${host[key] !== undefined}, ${separator})`;
        const fallback = host[attribute] === undefined ? "undefined" : quote(host[attribute]);
        const supplied = host[key] === undefined ? `${raw.get(name)} === undefined ? ${fallback} : ` : "";
        host[key] = expression(`${supplied}${checked} == null ? undefined : (${serialized})`, names, true);
      }
    };
    if (nativeView && child === undefined) {
      reflect();
      return renderChildren([root.flow?.kind === "with" ? { ...root, flow: undefined } as unknown as ElementNode : root], names, projection, true);
    }
    if (child !== undefined) {
      rootEvents.push(...events(root, names));
      if (root.ref !== undefined) ref(root.ref, true, current.contract.tag);
      const childProps = new Map<string, string>();
      const childStatuses = new Map<string, string>();
      for (const attribute of root.attributes) {
        const key = attribute.kind === "property" ? attribute.key : attribute.kind !== "directive" ? attribute.name : "";
        const inputName = receivingProp(child, key);
        if (inputName !== undefined) {
          childProps.set(inputName, attribute.kind === "literal" ? quote(attribute.value) : value(attribute.expressionPlan, names));
          childStatuses.set(inputName, attribute.kind === "literal" ? "READY_INPUT" : `evaluateInput(() => ${value(attribute.expressionPlan, inputScope(names, name => names.statuses.get(name)))}).status`);
        }
      }
      const markup = compose(child, childProps, { nodes: root.children, names, ...(projection === undefined ? {} : { parent: projection }) }, childStatuses);
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
  let template = compose(definition);
  if (acceptedTags.has(definition.contract.tag)) {
    // An accepted child: its parent's content query finds this entry, and `<slot of>` renders the slot templates it lists.
    if (nativeView) return unsupported(`an accepted component with a template root (<${definition.contract.tag}>).`);
    for (const name of placedSlots(definition)) outlet(name, definition);
    helper("children");
    const entry = field();
    // Plain content a hand-written consumer gives a slot: this child's own `<ng-content>` for it, in a template its parent's
    // `<slot of>` renders as plain content, or warns about when the outlet gives props.
    const captures = placedSlots(definition);
    template += captures.map(name => `<ng-template hnNextCapture><ng-content${name === "" ? "" : ` select="[slot='${escapeHtml(name)}']"`}></ng-content></ng-template>`).join("");
    if (captures.length > 0) fields.push("readonly hnCaptures = viewChildren(HtmlNextCapture);");
    const capture = (name: string): string => captures.includes(name) ? ` ?? this.hnCaptures()[${captures.indexOf(name)}]?.template` : "";
    fields.push(`readonly ${entry} = acceptedChild(${quote(definition.contract.tag)}, this.hnRoot.nativeElement, { ${Object.keys(definition.contract.props).map(name => `${propertyKey(name)}: () => ${ownNames!.code.get(name)}`).join(", ")} }, { ${[...slotDirectives].map(([name, slot]) => `${propertyKey(name)}: () => this.${slot.query}()?.template${capture(name)}`).join(", ")} });`);
    methods.push(`ngAfterContentInit(): void { connectChild(this.${entry}); }`);
    childProviders.push(`{ provide: ACCEPTED_CHILD, useFactory: () => inject(${definition.contract.name}).${entry} }`);
  }
  if (helpers.has("html-fragment")) template += angularHtmlFragmentTemplate();
  const hostModels = models.map(model => {
    helper("host"); helper("state"); helper("events");
    const { definition: current, names } = model;
    const mutable = (current.declarations ?? []).filter((item): item is import("../template.js").ReactiveDeclaration => item.kind === "state");
    const immutable = (current.declarations ?? []).filter((item): item is import("../template.js").ReactiveDeclaration | import("../template.js").ContextDeclaration => item.kind === "computed" || item.kind === "context");
    const props = Object.keys(current.contract.props);
    const entries = (names: readonly string[], read: (name: string) => string) => `{ ${names.map(name => `${propertyKey(name)}: ${read(name)}`).join(", ")} }`;
    const loader = options.controllerSpecifier?.(current.contract.tag) ?? current.module ?? current.controller;
    let controllerModule: string | undefined;
    if (loader !== undefined) {
      controllerModule = controllerImports.get(loader);
      if (controllerModule === undefined) {
        controllerModule = `hnControllerModule${controllerImports.size}`;
        controllerImports.set(loader, controllerModule);
      }
    }
    const loadController = `() => Promise.resolve(${controllerModule})`;
    const preparation = options.preparationForTag?.(current.contract.tag);
    const prepared = preparation === undefined || loader === undefined ? undefined : field();
    if (prepared !== undefined) {
      helper("bindings");
      fields.push(`readonly ${prepared} = preparedModule(${loadController}, ${sourceValue({ tag: current.contract.tag, source: preparation!.source })});`);
    }
    const contract = angularPropContract(current);
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
    return `{ tag: ${quote(current.contract.tag)}, definition: ${quote(options.definitionURL?.(current.contract.tag) ?? current.source.file)}, ${loader === undefined ? "" : `controller: ${quote(loader)}, module: ${current.module !== undefined}, load: ${prepared === undefined ? loadController : `this.${prepared}.load`}, ${prepared === undefined ? "" : `attach: this.${prepared}.attach,`}`}
      props: () => (${entries(props, name => names.code.get(name)!)}), rawProps: () => (${entries(props, name => model.inputs.get(name)!)}), callerProps: () => (${entries(props, name => model.raw.get(name)!)}),
      propContract: ${sourceValue(contract)},
      ${current.scripts === undefined ? "" : `scripts: () => this.hnHead.scripts(${quote(current.contract.tag)}),`}
      ${model.requests.length === 0 ? "" : `request: ${frameworkRequestSource(model.requests, options.definitionURL?.(current.contract.tag) ?? current.source.file)},
      responders: { ${model.requests.map(request => `${propertyKey(request.name)}: () => propResponder(this.${model.responders.get(request.name)![0]}(), this.${model.responders.get(request.name)![1]}())`).join(", ")} },`}

      state: ${entries(mutable.map(item => item.name), name => `{ get: () => ${names.code.get(name)}, set: value => this.${names.writes.get(name)}(value) }`)},
      computed: ${entries([...immutable.map(item => item.kind === "context" ? item.as ?? item.name : item.name), ...Object.values(current.contract.slots ?? {}).flatMap(slot => slot.as ?? [])], name => `() => ${names.code.get(name)}`)},
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
  const styles = compileComponentGraphStylesForConversion([...graph.values()].filter(item => chain.includes(item)), "attribute", graph);
  const usesProjection = template.includes("<ng-content") || slotDirectives.size > 0;
  if (usesProjection) helpers.add("projection");
  const usesSlots = helpers.has("slots");
  const usesHead = helpers.has("head");
  const usesRequests = helpers.has("requests");
  const usesHtml = helpers.has("html");
  const usesHtmlFragment = helpers.has("html-fragment");
  if (rootHtml !== undefined) host[`[attr.${VUE_ROOT_ATTRIBUTE}]`] = "hnRootBindings()";
  const usesData = helpers.has("data");
  const usesHost = helpers.has("host");
  const usesValue = helpers.has("value");
  const usesValidity = helpers.has("validity");
  const usesControl = helpers.has("control");
  const usesNativeControls = [...chain].some(item => {
    const visit = (node: TemplateNode): boolean => node.kind === "element" && (node.name === "input" || node.children.some(visit));
    return visit(item.template);
  });
  if (usesNativeControls) helper("native-controls");
  if (rootControls.length > 0) host[`[attr.${VUE_ROOT_ATTRIBUTE}]`] = "hnRootBindings()";
  const usesEvents = helpers.has("events");
  if (usesEvents) helpers.add("state");
  const hasContext = providers.length > 0 || helpers.has("context");
  if (hasContext) helper("context");
  if (usesValue || helpers.has("state") || lowering.helpers().some(name => name.startsWith("decimal"))) helper("expressions");
  const rootBindings = rootControls.length === 0 && rootHtml === undefined && rootProperties.length === 0 ? "" : `hnRootBindings(): string { ${rootProperties.join(" ")} ${rootControls.length === 0 ? "" : `this.hnControl.bindings = [${rootControls.join(", ")}];`} ${rootHtml === undefined ? "" : `this.hnHtml.binding = ${rootHtml};`} return ""; }`;
  if (rootBindings !== "") host[`[attr.${VUE_ROOT_ATTRIBUTE}]`] = "hnRootBindings()";
  const helperPath = (name: string) => quote(options.helperSpecifier?.(name) ?? `./${name}`);
  const component = `// Generated Angular component by HTML Next ${version}. Do not edit.\nimport { Component, ChangeDetectionStrategy, ViewEncapsulation, ElementRef, inject, input, signal, computed, viewChildren, contentChild, Directive, TemplateRef, ViewContainerRef, forwardRef, type EmbeddedViewRef, type Signal } from "@angular/core";\n${[...imports].filter(([tag]) => tag !== definition.contract.tag).map(([tag, name]) => `import ${name}${slotImports.has(tag) ? `, { ${[...slotImports.get(tag)!].join(", ")} }` : ""} from ${quote(options.importSpecifier?.(tag) ?? `./${name}`)};`).join("\n")}\n${helpers.has("state") ? `import { nativeBooleanAttribute, checkedInput, checkedProp, checkPropInput, updatePath, stateTokens, revertValue, evaluateInput, inputRead, requireInputStatus, READY_INPUT, UNRESOLVED_INPUT, initializedState, retainedComputed, reflectedInputs, inputDefault, type TrackedSignal, type InitializedSignal, type InputSnapshot, type InputStatus, acceptsControllerWrite, copyStateSeed, warnUnless, finiteResult, acceptsDeclaredEvent, acceptsDeclaredEvent as acceptsSlotProp, selectedPropNode } from ${helperPath("state")};` : ""}\n${usesSlots ? `import { NgTemplateOutlet } from "@angular/common";` : ""}\n${usesHead ? `import { HtmlNextHead, headText, headAttribute, headAttributes, headJson, type HeadEntry, type HeadScript, type DeclaredScript, type ScriptStatus } from ${helperPath("head")};` : ""}\n${usesRequests ? `import { frameworkRequest, propResponder, type RequestEvent, type Responder } from ${helperPath("requests")};` : ""}\n${usesHtml ? `import { HtmlNextHtml${usesHtmlFragment ? ", HtmlNextHtmlFragment, HtmlNextHtmlAttributes" : ""} } from ${helperPath("html")};` : ""}\n${helpers.has("attributes") ? `import { HtmlNextNamespacedAttributes } from ${helperPath("attributes")};` : ""}\n${usesData ? `import { createDataRead } from ${helperPath("data")};` : ""}\n${usesValidity ? `import { HtmlNextValidity, type ValidityBinding } from ${helperPath("validity")};` : ""}\n${usesHost ? `import { HtmlNextHost } from ${helperPath("host")};` : ""}\n${helpers.has("bindings") ? `import { preparedModule } from ${helperPath("bindings")};` : ""}\n${usesNativeControls ? `import { HtmlNextNativeControls } from ${helperPath("native-controls")};` : ""}\n${usesValue ? `import { HtmlNextValue${helpers.has("region") ? ", HtmlNextRegion" : ""}${usesSlots ? ", HtmlNextSlotValues" : ""} } from ${helperPath("value")};` : ""}\n${usesControl ? `import { HtmlNextControl } from ${helperPath("control")};` : ""}\n${usesProjection ? `import { HtmlNextProjection } from ${helperPath("projection")};` : ""}\n${usesEvents ? `import { HtmlNextEvents, dispatchDeclaredTargets } from ${helperPath("events")};` : ""}\n${hasContext ? `import { contextToken } from ${helperPath("context")};` : ""}${helpers.has("children") ? `\nimport { contentChildren } from "@angular/core";\nimport { ACCEPTED_CHILD, acceptedChild, acceptedChildren, connectChild, childSlot, childTag, HtmlNextCapture, HtmlNextChildSlot, HtmlNextPlain } from ${helperPath("children")};` : ""}\n${lowering.helpers().some(name => name.startsWith("decimal")) ? `import { ${lowering.helpers().filter(name => name.startsWith("decimal")).join(", ")} } from ${helperPath("expressions")};` : ""}\n${helpers.has("depth") ? `import { NESTED_DEPTH, checkNestedDepth } from ${helperPath("depth")};` : ""}\n${[...controllerImports].map(([specifier, name]) => `import * as ${name} from ${quote(specifier)};`).join("\n")}\n${lowering.referenceDeclarations().join("\n")}\n${lowering.moduleFallbacks().join("\n")}\n${lowering.fallbacks().join("\n")}\n${targetComponent(definition).events.length === 0 ? "" : `export interface ${definition.contract.name}Events { ${targetComponent(definition).events.map(event => `readonly ${propertyKey(event.name)}: CustomEvent<${event.detailType}>;`).join(" ")} }`}\n${[...slotDirectives.values()].map(slot => `@Directive({ selector: ${quote(`ng-template[${slot.selector}]`)}, standalone: true })
export class ${slot.name} {
  readonly template = inject<TemplateRef<${slot.type}>>(TemplateRef);
  static ngTemplateContextGuard(_directive: ${slot.name}, _context: unknown): _context is ${slot.type} { return true; }
}`).join("\n")}\n@Component({\n  selector: ${quote(`${native}[${definition.contract.tag}]`)},\n  standalone: true,\n  imports: [${[...[...imports.values()].map(name => `forwardRef(() => ${name})`), ...[...slotImports.values()].flatMap(names => [...names]), ...(usesNativeControls ? ["HtmlNextNativeControls"] : []), ...(usesSlots ? ["NgTemplateOutlet", "HtmlNextSlotValues"] : []), ...(template.includes("hnNextChildSlot") ? ["HtmlNextChildSlot"] : []), ...(template.includes("hnNextPlain") ? ["HtmlNextPlain"] : []), ...(template.includes("hnNextCapture") ? ["HtmlNextCapture"] : []), ...(usesEvents ? ["HtmlNextEvents"] : []), ...(usesControl ? ["HtmlNextControl"] : []), ...(usesValue ? ["HtmlNextValue"] : []), ...(helpers.has("region") ? ["HtmlNextRegion"] : []), ...(usesHtml ? ["HtmlNextHtml"] : []), ...(usesHtmlFragment ? ["HtmlNextHtmlFragment", "HtmlNextHtmlAttributes"] : []), ...(helpers.has("attributes") ? ["HtmlNextNamespacedAttributes"] : [])].join(", ")}],\n  ${rootEvents.length === 0 && rootControls.length === 0 && !usesProjection && !usesHost && !usesHead && !usesValidity && rootHtml === undefined ? "" : `hostDirectives: [${[...(rootEvents.length > 0 ? ["HtmlNextEvents"] : []), ...(usesProjection ? ["HtmlNextProjection"] : []), ...(rootControls.length > 0 ? ["HtmlNextControl"] : []), ...(usesHost ? ["HtmlNextHost"] : []), ...(usesHead ? ["HtmlNextHead"] : []), ...(usesValidity ? ["HtmlNextValidity"] : []), ...(rootHtml === undefined ? [] : ["HtmlNextHtml"])].join(", ")}],`}\n  preserveWhitespaces: true,\n  changeDetection: ChangeDetectionStrategy.OnPush,\n  encapsulation: ViewEncapsulation.None,\n  host: ${sourceValue(host, 2)},\n  ${hasContext || childProviders.length > 0 ? `providers: [${[...providers, ...childProviders].join(", ")}],` : ""}\n  template: ${quote(template)},\n  styles: [${quote(styles)}]\n})\nexport default class ${definition.contract.name}${generics.length === 0 ? "" : `<${generics.map(item => item.declaration).join(", ")}>`} {\n  readonly hnRoot = inject<ElementRef<HTMLElement>>(ElementRef);\n  ${usesHost ? "readonly hnHost = inject(HtmlNextHost);" : ""}\n  ${usesValidity ? "readonly hnValidity = inject(HtmlNextValidity);" : ""}\n  ${usesHead ? "readonly hnHead = inject(HtmlNextHead);" : ""}\n  ${rootControls.length === 0 ? "" : `readonly hnControl = inject(HtmlNextControl);`}\n  ${rootHtml === undefined ? "" : `readonly hnHtml = inject(HtmlNextHtml);`}\n  ${rootBindings}\n  ${[...slotDirectives.values()].map(slot => `readonly ${slot.query} = contentChild(${slot.name});`).join("\n  ")}\n  ${fields.join("\n  ")}\n  ${methods.join("\n  ")}\n  ${rootEvents.length === 0 ? "" : `readonly hnEvents = inject(HtmlNextEvents);`}\n  ${usesProjection ? `readonly hnProjection = inject(HtmlNextProjection);` : ""}\n  ${rootEvents.length === 0 && rootControls.length === 0 && !usesProjection && !usesHost && !usesHead && !usesValidity && rootHtml === undefined ? "" : `ngOnInit(): void { ${usesValidity ? `this.hnValidity.read = (): readonly ValidityBinding[] => [${validityModels.join(", ")}];` : ""} ${usesHead ? `this.hnHead.models = [${headModels.join(", ")}];` : ""} ${usesHost ? `this.hnHost.models = [${hostModels.join(", ")}];` : ""} ${rootEvents.length === 0 ? "" : `this.hnEvents.bindings = [${rootEvents.join(", ")}]; this.hnEvents.ngOnChanges();`} ${usesProjection ? `this.hnProjection.owners = ${sourceValue(chain.map(item => item.contract.tag))};` : ""} }`}\n}\n`;
  if (nativeView) {
    helper("view");
    helper("events");
    helper("state");
    const nativeEvents = new Set(Object.values(DOM_INTERFACES).flatMap(contract => Object.keys(contract.properties).filter(name => name.startsWith("on")).map(name => name.slice(2))));
    const events = new Map([...nativeEvents].map(name => [name, "Event"]));
    for (const event of targetComponent(definition).events) events.set(event.name, `CustomEvent<${event.detailType}>`);
    return { component: angularNativeViewSource({ component, name: definition.contract.name, tag: definition.contract.tag,
      declaration: generics.length === 0 ? "" : `<${generics.map(item => item.declaration).join(", ")}>`,
      arguments: generics.length === 0 ? "" : `<${generics.map(() => "any").join(", ")}>`,
      template, host, fields, methods: [...methods, rootBindings], styles,
      slotQueries: [...slotDirectives].map(([name, slot]) => `readonly ${slot.query} = () => { const template = this.hnSlotTemplates()[${quote(name)}]; return template ? { template } : undefined; };`),
      dependencies: [...imports.values(), ...[...slotImports.values()].flatMap(names => [...names]), ...(usesNativeControls ? ["HtmlNextNativeControls"] : []), ...(usesSlots ? ["NgTemplateOutlet", "HtmlNextSlotValues"] : []), ...(template.includes("hnNextChildSlot") ? ["HtmlNextChildSlot"] : []), ...(template.includes("hnNextPlain") ? ["HtmlNextPlain"] : []), ...(template.includes("hnNextCapture") ? ["HtmlNextCapture"] : []), ...(usesEvents ? ["HtmlNextEvents"] : []), ...(usesControl ? ["HtmlNextControl"] : []), ...(usesValue ? ["HtmlNextValue"] : []), ...(helpers.has("region") ? ["HtmlNextRegion"] : []), ...(usesHtml ? ["HtmlNextHtml"] : []), ...(usesHtmlFragment ? ["HtmlNextHtmlFragment", "HtmlNextHtmlAttributes"] : []), ...(helpers.has("attributes") ? ["HtmlNextNamespacedAttributes"] : [])],
      providers: [...providers, ...childProviders],
      injections: [...(usesValidity ? [{ name: "hnValidity", type: "HtmlNextValidity" }] : []), ...(rootEvents.length > 0 ? [{ name: "hnEvents", type: "HtmlNextEvents" }] : []), ...(usesProjection ? [{ name: "hnProjection", type: "HtmlNextProjection" }] : []), ...(usesHost ? [{ name: "hnHost", type: "HtmlNextHost" }] : []), ...(usesHead ? [{ name: "hnHead", type: "HtmlNextHead" }] : [])],
      initialize: `${usesValidity ? `this.hnValidity.read = (): readonly ValidityBinding[] => [${validityModels.join(", ")}];` : ""} ${usesHead ? `this.hnHead.models = [${headModels.join(", ")}];` : ""} ${usesHost ? `this.hnHost.models = [${hostModels.join(", ")}];` : ""} ${rootEvents.length === 0 ? "" : `this.hnEvents.bindings = [${rootEvents.join(", ")}]; this.hnEvents.ngOnChanges();`} ${usesProjection ? `this.hnProjection.owners = ${sourceValue(chain.map(item => item.contract.tag))};` : ""}`,
      props: Object.keys(definition.contract.props), events: [...events].map(([name, type]) => ({ name, type })),
      viewSpecifier: options.helperSpecifier?.("view") ?? "./view",
    }), helpers };
  }
  return { component, helpers };
}

export function angularArtifacts(version: string, helpers?: ReadonlySet<string>): readonly GeneratedArtifact[] {
  return [
    angularControlsRendererArtifact(version),
    angularBindingsArtifact(version),
    angularControlArtifact(version),
    angularNativeViewArtifact(version),
    { path: "angular/depth.ts", content: `import { InjectionToken } from "@angular/core";
export const NESTED_DEPTH = new InjectionToken<number>("html-next.nested-depth");
export function checkNestedDepth(depth: number, limit: number): number {
  if (depth >= limit) {
    const message = "Component invocations nested deeper than the lowering limit.";
    throw Object.assign(new Error("HR008: " + message), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR008", message }) });
  }
  return depth;
}
` },
    { path: "angular/expressions.ts", content: expressionHelpersSource() },
    angularHostArtifact(version),
    angularDataArtifact(version),
    angularHtmlArtifact(version),
    angularValidityArtifact(version),
    headHelperArtifact("angular", version),
    requestsArtifact("angular", version),
    { path: "angular/value.ts", content: `import { acceptsBindingResult } from "./expressions";\nimport { Pipe } from "@angular/core";
@Pipe({ name: "hnNextValue", standalone: true, pure: false })
export class HtmlNextValue {
  private accepted: any;
  transform(value: any): any {
    if (acceptsBindingResult(value) && (typeof value !== "number" || Number.isFinite(value))) this.accepted = value;
    return this.accepted;
  }
}
@Pipe({ name: "hnNextRegion", standalone: true, pure: false })
export class HtmlNextRegion {
  private accepted: { ready: boolean; value?: unknown } = { ready: false };
  transform(value: unknown): { ready: boolean; value?: unknown } {
    if (acceptsBindingResult(value) && (typeof value !== "number" || Number.isFinite(value))) this.accepted = { ready: true, value };
    return this.accepted;
  }
}
/** Each embedded view retains each slot prop independently when its expression is invalid. */
@Pipe({ name: "hnNextSlotValues", standalone: true, pure: false })
export class HtmlNextSlotValues {
  private accepted: Record<string, unknown> = Object.create(null);
  transform(values: Record<string, unknown>, defaults: Record<string, unknown> = {}): any {
    let next = this.accepted;
    for (const [name, candidate] of Object.entries(values)) {
      const value = candidate === Symbol.for("html-next.invalid-result") || typeof candidate === "number" && !Number.isFinite(candidate)
        ? Object.hasOwn(this.accepted, name) ? this.accepted[name] : defaults[name] ?? null : candidate;
      if (!Object.hasOwn(this.accepted, name) || !Object.is(this.accepted[name], value)) {
        if (next === this.accepted) next = { ...this.accepted };
        Object.defineProperty(next, name, { value, configurable: true, enumerable: true, writable: true });
      }
    }
    return this.accepted = next;
  }
}\n` },
    { path: "angular/state.ts", content: `import { acceptsBindingResult } from "./expressions";\nimport { computed, signal, type Signal } from "@angular/core";\n${typedPropsModule(version)}\n${DECLARED_EVENT_TYPE_SOURCE}
${AUTHORED_CHECK_SOURCE}
/** Angular attribute bindings stringify false; native boolean attributes must be absent instead. */
export function nativeBooleanAttribute(value: unknown): unknown { return value === false || value == null ? undefined : value === true ? "" : value; }
/** Structured inspection metadata retains its first input, while authored bindings stay live. */
export function reflectedInputs() {
  const structured = new Map<string, string | undefined>();
  return (name: string, value: unknown, bound: boolean, separator?: string): string | undefined => {
    if (value == null) return undefined;
    if (!bound && typeof value === "object" && structured.has(name)) return structured.get(name);
    const text = Array.isArray(value) && separator !== undefined ? value.join(separator) : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (!bound && typeof value === "object") structured.set(name, text);
    return text;
  };
}
/** Prop type refusal preserves the accepted value; null has already resolved its default. */
export function checkedInput<T>(value: unknown, type: Parameters<typeof checkPropInput>[1], required: boolean, name: string, accepted: Record<string, unknown>): T | null {
  return required ? checkedProp<T>(value, type, true, name, accepted) : checkedProp<T>(value, type, false, name, accepted);
}
export function finiteResult(value: unknown): unknown { return typeof value === "number" && !Number.isFinite(value) ? Symbol.for("html-next.invalid-result") : value; }
export type TrackedSignal = Signal<any> & { status(): InputStatus };
export function retainedComputed(evaluate: () => { value: unknown; status: InputStatus }, type: Parameters<typeof checkPropInput>[1]): TrackedSignal {
  let accepted: unknown = null;
  const evaluated = computed(() => {
    const next = evaluate();
    if (next.status.ready && next.value !== undefined && acceptsBindingResult(next.value)) {
      const checked = checkPropInput(next.value, type, false);
      if (checked.ok) accepted = checked.value;
    }
    return { value: next.value === undefined ? null : accepted, status: next.status };
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
      const accepted = next.status.ready && next.value !== undefined && acceptsBindingResult(next.value) && acceptsControllerWrite(next.value, type, []);
      if (accepted) { initialized = true; value = copyStateSeed(next.value); }
      else return { value: undefined, status: next.status };
    }
    return { value, status: READY_INPUT };
  });
  return Object.assign(computed<any>(() => current().value), { status: () => current().status,
    set(next: unknown): void { initialized = true; value = next; version.update(value => value + 1); } });
}
\nexport function revertValue(value: unknown, fallback: unknown): unknown { return value ?? fallback; }\n${NATIVE_PATH_WRITE_SOURCE.replace("writeBoundPath", "updatePath")}\nexport function stateTokens(values: Record<string, unknown>): string {\n  return Object.entries(values).flatMap(([name, value]) => [\n    ...(value === true || typeof value === "string" && value.length > 0 || typeof value === "number" && value !== 0 && Number.isFinite(value) ? [name] : []),\n    ...(typeof value === "string" || typeof value === "number" ? [name + "=" + encodeURIComponent(String(value))] : [])\n  ]).join(" ");\n}\n` },
    { path: "angular/children.ts", content: `import { ChangeDetectorRef, DestroyRef, Directive, ElementRef, InjectionToken, Injector, Input, TemplateRef, ViewContainerRef, computed, inject, signal, type Signal, type WritableSignal } from "@angular/core";
/** An accepted child (components#slot-accepts-as): its tag, the slot its \`slot\` attribute routes it to, and the entry its parent's \`as\` list holds. */
export interface AcceptedChild { readonly tag: string; readonly slot: string; readonly entry: object }
/** A parent's list of accepted children, read like a signal. */
export interface AcceptedChildren { (): readonly AcceptedChild[]; check(): void }
/** Each accepted child provides this, so a content query lists them in the consumer's content order. */
export const ACCEPTED_CHILD = new InjectionToken<AcceptedChild>("html-next.accepted-child");
const children = new WeakMap<object, { readonly tag: string; readonly slots: Readonly<Record<string, () => TemplateRef<any> | undefined>> }>();
/**
 * A content query lists the children declared in its parent's content. A child that another template renders
 * there, such as through \`ngTemplateOutlet\`, reaches its parent through the DOM instead: the nearest ancestor
 * whose slot accepts its tag. Until its parent places it, it waits here.
 */
const roots = new WeakMap<AcceptedChild, Element>();
const parents = new WeakMap<Element, { readonly tags: readonly string[]; readonly list: WritableSignal<readonly AcceptedChild[]> }>();
const owners = new WeakMap<AcceptedChild, WritableSignal<readonly AcceptedChild[]>>();
const unplaced = new Set<AcceptedChild>();
// 4: DOCUMENT_POSITION_FOLLOWING, without the browser's Node global on the server.
const documentOrder = (a: AcceptedChild, b: AcceptedChild): number => roots.get(a)!.compareDocumentPosition(roots.get(b)!) & 4 ? -1 : 1;
/** Joins the list of the nearest accepting ancestor, or waits until one places this child. */
export function connectChild(child: AcceptedChild): void {
  if (owners.has(child)) return;
  for (let node = roots.get(child)!.parentNode; node !== null; node = node.parentNode) {
    const parent = parents.get(node as Element);
    if (parent === undefined || !parent.tags.includes(child.tag)) continue;
    unplaced.delete(child); owners.set(child, parent.list);
    parent.list.update(list => [...list, child].sort(documentOrder));
    return;
  }
  unplaced.add(child);
}
/** A stable, read-only entry holding the child's resolved props; its tag and slot templates stay private to \`<slot of>\`. */
export function acceptedChild(tag: string, root: Element, props: Readonly<Record<string, () => unknown>>, slots: Readonly<Record<string, () => TemplateRef<any> | undefined>>): AcceptedChild {
  const entry = Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.entries(props).map(([name, read]) => [name, { get: read, enumerable: true }]))));
  children.set(entry, { tag, slots });
  const child: AcceptedChild = { tag, get slot() { return root.getAttribute("slot") ?? ""; }, entry };
  roots.set(child, root);
  inject(DestroyRef).onDestroy(() => { unplaced.delete(child); owners.get(child)?.update(list => list.filter(item => item !== child)); });
  return child;
}
/**
 * A parent's accepted children: its content query's, in content order, and the children other templates render
 * into its content, which join in document order. \`check\` runs after each check of the parent's view, once its
 * outlets place the waiting children.
 */
export function acceptedChildren(host: Element, tags: readonly string[], query: Signal<readonly AcceptedChild[]>): AcceptedChildren {
  const list = signal<readonly AcceptedChild[]>([]);
  parents.set(host, { tags, list });
  return Object.assign(computed(() => {
    const listed = query();
    const others = list().filter(child => !listed.includes(child));
    return others.length === 0 ? listed : [...listed, ...others].sort(documentOrder);
  }), { check(): void {
    for (const child of unplaced) connectChild(child);
    const sorted = [...list()].sort(documentOrder);
    if (sorted.some((child, index) => child !== list()[index])) list.set(sorted);
  } });
}
const child = (entry: unknown) => entry !== null && typeof entry === "object" ? children.get(entry) : undefined;
/** The consumer's template for an entry's slot, or undefined for a null entry or a slot it gave no content. */
export function childSlot(entry: unknown, name: string): TemplateRef<any> | undefined { return child(entry)?.slots[name]?.(); }
/** The accepted component an entry belongs to, whose slot declaration shapes the outlet's props. */
export function childTag(entry: unknown): string | undefined { return child(entry)?.tag; }
// By the template's anchor: each directive that injects TemplateRef receives its own object for one template.
const plain = new WeakSet<object>();
/** Marks a consumer's plain content for a child's slot, which keeps its identity where \`<slot of>\` places it. */
@Directive({ selector: "ng-template[hnNextPlain]", standalone: true })
export class HtmlNextPlain { constructor() { plain.add(inject(TemplateRef).elementRef.nativeElement); } }
const captured = new WeakSet<object>();
/** An accepted child's own \`<ng-content>\` for a slot its parent places: the consumer's plain content for it, kept as plain content. */
@Directive({ selector: "ng-template[hnNextCapture]", standalone: true })
export class HtmlNextCapture {
  readonly template = inject(TemplateRef);
  constructor() { plain.add(this.template.elementRef.nativeElement); captured.add(this.template.elementRef.nativeElement); }
}
const filled = new WeakMap<object, boolean>();
/**
 * Whether a capture holds an element or text other than whitespace; an empty one leaves the outlet its fallback.
 * ponytail: read once per capture, so content toggled later inside a projected control-flow block keeps the first answer.
 */
function captureFilled(template: TemplateRef<any>): boolean {
  const anchor = template.elementRef.nativeElement;
  let known = filled.get(anchor);
  if (known === undefined) {
    const view = template.createEmbeddedView({});
    known = view.rootNodes.some((node: Node) => node.nodeType === 1 || node.nodeType === 3 && (node as Text).data.trim() !== "");
    view.destroy();
    filled.set(anchor, known);
  }
  return known;
}
const warned = new Set<string>();
const claims = new WeakMap<TemplateRef<any>, HtmlNextChildSlot>();
const waiting = new WeakMap<TemplateRef<any>, Set<HtmlNextChildSlot>>();
/**
 * \`<slot of>\`: renders an accepted child's content for one of its slots with the outlet's props, or the fallback.
 * Plain content keeps its identity: it renders at the first outlet that places it, later outlets show their
 * fallback, and when that outlet lets it go the first waiting outlet in document order takes it. An outlet
 * that gives props shows its fallback for plain content, and warns once with \`plainWarning\`.
 */
@Directive({ selector: "[hnNextChildSlot]", standalone: true })
export class HtmlNextChildSlot {
  @Input("hnNextChildSlot") template: TemplateRef<any> | undefined;
  @Input("hnNextChildSlotContext") context: Record<string, unknown> = {};
  @Input("hnNextChildSlotFallback") fallback: TemplateRef<any> | undefined;
  @Input("hnNextChildSlotPlainWarning") plainWarning: string | undefined;
  private readonly container = inject(ViewContainerRef);
  private readonly anchor = inject<ElementRef<Node>>(ElementRef).nativeElement;
  private readonly changes = inject(ChangeDetectorRef);
  // Content declared outside the parent reads the parent's context through the outlet.
  private readonly injector = inject(Injector);
  private shown: TemplateRef<any> | undefined;
  private claimed: TemplateRef<any> | undefined;
  private waits: TemplateRef<any> | undefined;
  ngOnChanges(): void { this.render(); }
  private render(): void {
    let template = this.template;
    if (template !== undefined && captured.has(template.elementRef.nativeElement) && !captureFilled(template)) template = undefined;
    if (this.claimed !== template) this.release();
    if (this.waits !== template) this.stopWaiting();
    if (template !== undefined && plain.has(template.elementRef.nativeElement) && this.plainWarning !== undefined) {
      if (!warned.has(this.plainWarning)) { warned.add(this.plainWarning); console.warn(this.plainWarning); }
      template = undefined;
    } else if (template !== undefined && plain.has(template.elementRef.nativeElement)) {
      const owner = claims.get(template);
      if (owner === undefined || owner === this) { claims.set(template, this); this.claimed = template; } else {
        let queue = waiting.get(template);
        if (queue === undefined) waiting.set(template, queue = new Set());
        queue.add(this); this.waits = template; template = undefined;
      }
    }
    template ??= this.fallback;
    if (template === this.shown) return;
    this.container.clear();
    this.shown = template;
    // The view reads the outlet's current props, as NgTemplateOutlet's context does.
    if (template !== undefined) this.container.createEmbeddedView(template, new Proxy({}, { get: (_target, name) => Reflect.get(this.context, name) }), { injector: this.injector });
  }
  private stopWaiting(): void {
    if (this.waits !== undefined) waiting.get(this.waits)?.delete(this);
    this.waits = undefined;
  }
  private release(): void {
    const template = this.claimed;
    this.claimed = undefined;
    if (template === undefined || claims.get(template) !== this) return;
    claims.delete(template);
    // 4: DOCUMENT_POSITION_FOLLOWING, without the browser's Node global on the server.
    const next = [...waiting.get(template) ?? []].sort((a, b) => a.anchor.compareDocumentPosition(b.anchor) & 4 ? -1 : 1)[0];
    if (next === undefined) return;
    next.stopWaiting(); next.render(); next.changes.markForCheck();
  }
  ngOnDestroy(): void { this.release(); this.stopWaiting(); }
}
` },
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
