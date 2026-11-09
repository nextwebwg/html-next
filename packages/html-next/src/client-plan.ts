import type { ComponentDefinition, TemplateNode } from "./template.js";

/** Inputs that a server cannot infer from the component templates. Tags refer to this build's graph. */
export interface ClientPlanOptions {
  /** Roots the server may render. Omit to consider every definition. */
  readonly entries?: readonly string[];
  /** Factories needed for later creation, such as client navigation. */
  readonly creationRoots?: readonly string[] | "all";
  /** Existing hosts application code may update or look up through public APIs. */
  readonly publicRoots?: readonly string[] | "all";
}

/** Serializable compiler output shared by server implementations. It contains no request data. */
export interface ClientPlan {
  readonly version: 1;
  readonly entries: readonly string[];
  readonly adoption: readonly string[];
  readonly creation: readonly string[];
  readonly components: readonly {
    readonly tag: string;
    readonly dependencies: readonly string[];
    readonly adopt: boolean;
    readonly create: boolean;
    readonly reasons: readonly string[];
  }[];
}

/**
 * Select browser factories without consulting the current server data or evaluating modules.
 * An adopted factory owns its invocations, so retain their whole ownership region. This preserves
 * future branches, projection, and root aliases; ESM tree shaking still selects individual helpers.
 * A module is opaque and keeps its host live, even when no declarative event names it.
 */
export function analyzeClientPlan(definitions: Iterable<ComponentDefinition>, options: ClientPlanOptions = {}): ClientPlan {
  const graph = new Map<string, { definition: ComponentDefinition; dependencies: Set<string>; reasons: Set<string> }>();
  for (const definition of definitions) {
    const tag = definition.contract.tag;
    if (graph.has(tag)) throw new TypeError(`Client graph contains duplicate <${tag}> definitions.`);
    graph.set(tag, { definition, dependencies: new Set(), reasons: new Set() });
  }
  const tags = [...graph.keys()].sort();
  const roots = (names: readonly string[] | "all" | undefined): readonly string[] => {
    const selected = names === "all" ? tags : [...new Set(names ?? [])].sort();
    for (const tag of selected) if (!graph.has(tag)) throw new TypeError(`Client graph has no definition for <${tag}>.`);
    return selected;
  };
  const entries = roots(options.entries ?? tags);
  const publicRoots = roots(options.publicRoots);
  const creationRoots = roots(options.creationRoots);
  const contexts = new Map<string, Set<string>>();
  for (const [tag, node] of graph) {
    const { definition, dependencies, reasons } = node;
    const invoke = (name: string): void => { if (graph.has(name)) dependencies.add(name); };
    const visit = (item: TemplateNode): void => {
      if (item.kind === "text") return;
      if (item.kind === "slot") { item.fallback?.forEach(visit); return; }
      invoke(item.name);
      if (item.events?.length) reasons.add("event");
      if (item.attributes.some(attribute => attribute.kind === "attribute" && attribute.twoWay)) reasons.add("two-way-binding");
      if (item.transition !== undefined) reasons.add("transition");
      item.children.forEach(visit);
    };
    visit(definition.template);
    if (definition.root?.kind === "component") invoke(definition.root.tag);
    for (const slot of definition.slots ?? []) slot.accepts?.forEach(invoke);
    for (const slot of Object.values(definition.contract.slots ?? {})) slot.accepts?.forEach(invoke);
    if (definition.module !== undefined) reasons.add("module");
    if (definition.controller !== undefined) reasons.add("controller");
    if (definition.lifecycle !== undefined) reasons.add("lifecycle");
    if (definition.scripts?.length) reasons.add("script");
    if (definition.head?.length) reasons.add("head");
    for (const declaration of definition.declarations ?? []) {
      if (declaration.kind === "data") reasons.add("read");
      if (declaration.kind !== "context") continue;
      reasons.add("context");
      if (!graph.has(declaration.from)) continue;
      const providers = contexts.get(tag) ?? new Set();
      providers.add(declaration.from);
      contexts.set(tag, providers);
    }
  }
  const closure = (initial: Iterable<string>): Set<string> => {
    const result = new Set(initial);
    for (const tag of result) for (const dependency of graph.get(tag)!.dependencies) result.add(dependency);
    return result;
  };
  // A context provider can be a separate entry, rather than a syntactic template dependency.
  const reachable = closure([...entries, ...publicRoots, ...creationRoots]);
  for (const tag of reachable) for (const provider of contexts.get(tag) ?? []) {
    for (const dependency of closure([provider])) reachable.add(dependency);
  }
  // Arbitrary module code can import public host/factory APIs. The compiler cannot prove which
  // other definitions it will reach, so preserve the whole graph even with known application roots.
  const opaqueAccess = [...reachable].some(tag => {
    const definition = graph.get(tag)!.definition;
    return definition.module !== undefined || definition.controller !== undefined;
  });
  if (opaqueAccess) for (const tag of tags) reachable.add(tag);
  const adopted = new Set([...reachable].filter(tag => graph.get(tag)!.reasons.size > 0));
  if (opaqueAccess) for (const tag of tags) { adopted.add(tag); graph.get(tag)!.reasons.add("opaque-module-access"); }
  for (const tag of publicRoots) { adopted.add(tag); graph.get(tag)!.reasons.add("public-access"); }
  // The finite fixed point includes both invocation owners and invoked factories. Do not inspect
  // SSR branch values: a currently absent child can appear after an event or a public prop update.
  let changed = true;
  while (changed) {
    changed = false;
    const keep = (tag: string): void => { if (!adopted.has(tag)) { adopted.add(tag); changed = true; } };
    for (const tag of reachable) {
      for (const dependency of graph.get(tag)!.dependencies) {
        if (adopted.has(tag)) keep(dependency);
        if (adopted.has(dependency)) keep(tag);
      }
      for (const provider of contexts.get(tag) ?? []) {
        if (adopted.has(tag)) keep(provider);
        if (adopted.has(provider)) keep(tag);
      }
    }
  }
  const created = closure([...adopted, ...creationRoots]);
  for (const [tag, node] of graph) {
    if (!adopted.has(tag)) node.reasons.clear();
    for (const dependency of node.dependencies) {
      if (adopted.has(tag) && adopted.has(dependency)) {
        graph.get(dependency)!.reasons.add(`invoked-by:${tag}`);
        node.reasons.add(`owns:${dependency}`);
      }
    }
    for (const provider of contexts.get(tag) ?? []) if (adopted.has(tag)) {
      node.reasons.add(`context-from:${provider}`);
      graph.get(provider)!.reasons.add(`provides-context:${tag}`);
    }
    if (created.has(tag) && !adopted.has(tag)) node.reasons.add("creation");
  }
  return Object.freeze({
    version: 1,
    entries: Object.freeze(entries),
    adoption: Object.freeze([...adopted].sort()),
    creation: Object.freeze([...created].sort()),
    components: Object.freeze(tags.map(tag => {
      const node = graph.get(tag)!;
      return Object.freeze({ tag, dependencies: Object.freeze([...node.dependencies].sort()),
        adopt: adopted.has(tag), create: created.has(tag), reasons: Object.freeze([...node.reasons].sort()) });
    })),
  });
}
