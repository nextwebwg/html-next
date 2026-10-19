/**
 * A typed controller host for one component: what `<defs>` declares, as the TypeScript types the
 * Vanilla declaration and the framework targets already use. The declaration is self-contained, so
 * it type-checks wherever the controller lives, with or without `@nextwebwg/html-next` installed.
 */
import { getDomInterface } from "../platform.js";
import { iteratedRefNames, rootArms, type ComponentDefinition, type TemplateNode } from "../template.js";
import { declarationTypeNode, normalizeType, parseTypeExpression, typeScriptType } from "../type-system.js";
import { targetComponent } from "./backend.js";
import { propKey, propTypeSource } from "./shared.js";
import { present, typeOf, typeScript, UNKNOWN, type Static } from "./vue-lowering.js";

const PRELUDE = `/** A prop's accepted value, its latest direct input, and that input's validity. */
export interface HostProp<T> {
  readonly value: T;
  readonly inputValue: unknown;
  readonly validity: HostValidity;
  validate(): HostValidity;
}
export interface HostValidity {
  readonly valid: boolean;
  readonly valueMissing: boolean;
  readonly typeMismatch: boolean;
  readonly patternMismatch: boolean;
  readonly tooLong: boolean;
  readonly tooShort: boolean;
  readonly rangeUnderflow: boolean;
  readonly rangeOverflow: boolean;
  readonly stepMismatch: boolean;
  readonly badInput: boolean;
  readonly customError: boolean;
  readonly schemaMismatch: boolean;
  readonly untrustedValue: boolean;
  readonly errors: readonly { readonly reason: string; readonly message: string; readonly path?: string }[];
}
/** A declared \`<data>\` resource: its last resolved value and request status. */
export interface HostData<T> {
  readonly value: T | null;
  readonly pending: boolean;
  readonly ok: boolean;
  readonly error: unknown;
}
/** A named declared script. */
export interface HostScript {
  readonly pending: boolean;
  readonly ok: boolean;
  readonly error: Event | TypeError | null;
  readonly ready: Promise<void>;
  load(): Promise<void>;
}
export interface HostRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly progress?: ((loaded: number, total: number) => void) | undefined;
}
/** A request as its responder receives it. */
export interface HostRequestEvent<Detail, Answer> extends CustomEvent<Detail> {
  readonly signal: AbortSignal;
  respondWith(answer: Answer | null | PromiseLike<Answer | null>): void;
  progress(loaded: number, total: number): void;
}
export interface HostComputed<T> { get(): T }
export interface HostSignal<T> extends HostComputed<T> {
  set(value: T): void;
  update(update: (value: T) => T): void;
}
export type HostCleanup = void | (() => void);
`;

const CONDITIONAL = new Set(["if", "when", "else", "with"]);

/** An object type's members, nested one level below `indent`. */
function members(entries: readonly string[], indent = "  "): string {
  return entries.length === 0 ? "{}" : `{\n${entries.map((entry) => `${indent}  ${entry};`).join("\n")}\n${indent}}`;
}

function union(types: Iterable<string>): string {
  return [...new Set(types)].join(" | ");
}

/** The tags a template invokes, so a controller's `on()` knows their events and requests. */
function invokedTags(node: TemplateNode, tags: Set<string> = new Set()): Set<string> {
  if (node.kind === "text") return tags;
  if (node.kind === "slot") {
    for (const child of node.fallback ?? []) invokedTags(child, tags);
    return tags;
  }
  if (node.name.includes("-")) tags.add(node.name);
  for (const child of node.children) invokedTags(child, tags);
  return tags;
}

/** Each ref's element types, and whether every rendering of it is unconditional. */
function refTypes(definition: ComponentDefinition, definitions: ReadonlyMap<string, ComponentDefinition>): ReadonlyMap<string, { types: Set<string>; always: boolean }> {
  const refs = new Map<string, { types: Set<string>; always: boolean }>();
  const elementType = (name: string): string => {
    const invoked = definitions.get(name);
    if (invoked !== undefined) return getDomInterface(invoked.contract.nativeElement) ?? "HTMLElement";
    return getDomInterface(name) ?? (name.includes("-") ? "HTMLElement" : "Element");
  };
  const walk = (node: TemplateNode, conditional: boolean): void => {
    if (node.kind === "text") return;
    if (node.kind === "slot") {
      for (const child of node.fallback ?? []) walk(child, true);
      return;
    }
    const inside = conditional || (node.flow !== undefined && CONDITIONAL.has(node.flow.kind));
    if (node.ref !== undefined) {
      const entry = refs.get(node.ref) ?? { types: new Set<string>(), always: false };
      entry.types.add(elementType(node.name));
      entry.always ||= !inside;
      refs.set(node.ref, entry);
    }
    for (const child of node.children) walk(child, inside);
  };
  walk(definition.template, false);
  return refs;
}

/** Each state, computed and context name's TypeScript type, as the framework targets type them. */
function stateTypes(
  definition: ComponentDefinition,
  definitions: ReadonlyMap<string, ComponentDefinition>,
  seen: Set<ComponentDefinition> = new Set(),
): Map<string, { readonly type: string; readonly writable: boolean }> {
  seen.add(definition);
  const types = new Map<string, Static>();
  for (const [name, prop] of Object.entries(definition.contract.props)) {
    types.set(name, { ...present(normalizeType(prop.type)), nullable: true });
  }
  const scope = { code: new Map<string, string>(), types };
  const result = new Map<string, { type: string; writable: boolean }>();
  for (const declaration of definition.declarations ?? []) {
    if (declaration.kind === "state") {
      // The same inference React conversion gives a state: its declared type, or its initial value's.
      const inferred = declaration.expression === undefined ? UNKNOWN : typeOf(declaration.expression.ast, scope);
      const declared = declarationTypeNode(declaration.type, declaration.shape);
      const value = declared === undefined ? inferred : present(declared);
      types.set(declaration.name, { ...value, nullable: value.nullable || declaration.expression === undefined });
      result.set(declaration.name, {
        type: declaration.expression === undefined && declared !== undefined
          ? `${typeScript(present(declared))} | undefined` : typeScript(types.get(declaration.name)!),
        writable: true,
      });
    } else if (declaration.kind === "computed") {
      const declared = declarationTypeNode(declaration.type, declaration.shape);
      const value = declared === undefined
        ? declaration.expression === undefined ? UNKNOWN : typeOf(declaration.expression.ast, scope)
        : present(declared);
      types.set(declaration.name, value);
      result.set(declaration.name, { type: declared === undefined ? typeScript(value) : typeScriptType(declared), writable: false });
    } else if (declaration.kind === "context") {
      const provider = definitions.get(declaration.from);
      const provided = provider === undefined || seen.has(provider) ? undefined
        : stateTypes(provider, definitions, seen).get(declaration.name)?.type;
      result.set(declaration.as ?? declaration.name, { type: provided ?? "unknown", writable: false });
    }
  }
  return result;
}

/**
 * The `<tag>.host.d.ts` declaration for a component's controller: `Host`, and `Controller`, the
 * controller module's default export. `definitions` are the linked graph's components by tag; their
 * events and requests type `host.on`, and their roots type refs to them.
 */
export function generateHostDeclaration(
  definition: ComponentDefinition,
  version: string,
  definitions: ReadonlyMap<string, ComponentDefinition> = new Map(),
): string {
  const target = targetComponent(definition);
  const { contract } = definition;
  const rootType = rootArms(definition.template) === undefined ? getDomInterface(contract.nativeElement) ?? "HTMLElement" : "HTMLElement";
  const declarations = definition.declarations ?? [];

  const props = target.props.map(({ name, contract: prop }) => {
    const defaulted = prop.default !== undefined && prop.default !== null;
    const type = defaulted && !prop.required ? propTypeSource({ ...prop, required: true }) : propTypeSource(prop);
    return `readonly ${propKey(name)}: HostProp<${type}>`;
  });
  const state = [...stateTypes(definition, definitions)].map(([name, { type, writable }]) =>
    `${writable ? "" : "readonly "}${propKey(name)}: ${type}`);
  const data = declarations.flatMap((declaration) => declaration.kind !== "data" ? [] : [
    `readonly ${propKey(declaration.name)}: HostData<${declaration.type === undefined ? "unknown"
      : declaration.type === "text" ? "string" : typeScriptType(parseTypeExpression(declaration.type))}>`,
  ]);
  const iterated = iteratedRefNames(definition);
  const refs = [...refTypes(definition, definitions)].map(([name, { types, always }]) => {
    const element = union(types);
    return iterated.has(name) ? `readonly ${propKey(name)}: readonly ${types.size === 1 ? element : `(${element})`}[]`
      : `readonly ${propKey(name)}: ${element}${always ? "" : " | undefined"}`;
  });
  const slotContracts = definition.slots ?? [];
  const slots = [
    ...new Set(slotContracts.map((slot) => slot.name ?? "default")),
  ].map((name) => `readonly ${propKey(name)}: readonly Element[]`);
  const scripts = (contract.scripts ?? []).flatMap((script) =>
    script.name === undefined ? [] : [`readonly ${propKey(script.name)}: HostScript`]);

  // What `host.on` hears on the root: this component's own events and requests, those of the
  // components its template invokes (which bubble to it), and disconnection. Only a `connect`
  // callback's return value is used, as the cleanup that runs on disconnection.
  const listeners = new Map<string, Set<string>>([["disconnect", new Set(["Event"])]]);
  const listen = (name: string, type: string): void => {
    listeners.set(name, (listeners.get(name) ?? new Set()).add(type));
  };
  const heard = [target, ...[...invokedTags(definition.template)].flatMap((tag) => {
    const invoked = definitions.get(tag);
    return invoked === undefined || invoked === definition ? [] : [targetComponent(invoked)];
  })];
  for (const component of heard) {
    for (const event of component.events) listen(event.name, `CustomEvent<${event.detailType}>`);
    for (const request of component.requests) listen(request.name, `HostRequestEvent<${request.detailType}, ${request.answerType}>`);
  }

  // Literal name unions, so a misspelled name's error lists the declared ones.
  const names = (list: readonly { readonly name: string }[]): string =>
    list.length === 0 ? "never" : list.map((item) => JSON.stringify(item.name)).join(" | ");
  const lines = [
    `// Generated by HTML Next ${version} for the <${contract.tag}> controller. Do not edit.`,
    PRELUDE,
    `/** <${contract.tag}>'s declared events, by name: each one's detail type. */`,
    `export interface HostEvents ${members(target.events.map((event) => `${propKey(event.name)}: ${event.detailType}`), "")}`,
    `/** <${contract.tag}>'s declared requests, by name: each one's detail and answer types. */`,
    `export interface HostRequests ${members(target.requests.map((request) =>
      `${propKey(request.name)}: { detail: ${request.detailType}; answer: ${request.answerType} }`), "")}`,
    "/** What `host.on` hears on the root, by type. */",
    `export interface HostListeners ${members([...listeners].map(([name, types]) => `${propKey(name)}: ${union(types)}`), "")}`,
    `/** The host <${contract.tag}>'s controller receives. */`,
    "export interface Host {",
    `  readonly root: ${rootType};`,
    `  readonly element: ${rootType};`,
    `  readonly props: ${members(props)};`,
    `  readonly state: ${members(state)};`,
    `  readonly data: ${members(data)};`,
    `  readonly refs: ${members(refs)};`,
    `  readonly slots: ${members(slots)};`,
    `  readonly scripts: ${members(scripts)};`,
    "  signal<T>(initialValue: T): HostSignal<T>;",
    "  computed<T>(compute: () => T): HostComputed<T>;",
    "  effect(run: () => HostCleanup): () => void;",
    "  on(type: \"connect\", callback: (event: Event) => HostCleanup): () => void;",
    `  on<K extends ${[...listeners.keys()].map((name) => JSON.stringify(name)).join(" | ")}>(type: K, callback: (event: HostListeners[K]) => unknown): () => void;`,
    "  on<K extends keyof HTMLElementEventMap>(type: K, callback: (event: HTMLElementEventMap[K]) => unknown): () => void;",
    "  on(type: string, callback: (event: Event) => unknown): () => void;",
    `  dispatch<K extends ${names(target.events)}>(name: K, detail?: HostEvents[K]): boolean;`,
    ...target.requests.length === 0 ? [] : [
      `  request<K extends ${names(target.requests)}>(name: K, ...rest: [HostRequests[K]["detail"]] extends [null]`,
      "    ? [detail?: null, options?: HostRequestOptions] : [detail: HostRequests[K][\"detail\"], options?: HostRequestOptions]): Promise<HostRequests[K][\"answer\"] | null>;",
      `  hasResponder(name: ${names(target.requests)}): boolean;`,
    ],
    "}",
    `/** <${contract.tag}>'s controller: the default export of its controller module. */`,
    "export type Controller = (host: Host) => HostCleanup | Promise<HostCleanup>;",
    ...(definition.module === undefined ? [] : [
      "/** Browser activation; cancelled when this connection ends. */",
      "export type Connect = (host: Host, context: { readonly signal: AbortSignal }) => HostCleanup | Promise<HostCleanup>;",
    ]),
    "",
  ];
  return lines.join("\n");
}
