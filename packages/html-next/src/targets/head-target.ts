import type { GeneratedArtifact } from "../generate.js";
import { HEAD_SOURCE } from "../generated/head-source.js";
import type { CompiledExpression } from "../expression.js";
import type { ComponentDefinition } from "../template.js";
import { quote } from "./shared.js";

/**
 * Head declarations in converted Vue, React and Svelte components: each target's `head` helper is
 * src/head.ts, the manager every HTML Next bundle on a page shares, with the framework's adapter.
 * Only a component that declares head content imports it.
 */
const FRAMEWORK_SOURCE = `
const INVALID = Symbol.for("html-next.invalid-result");

/** A declared script as a converted component passes it: the script, its name, handlers, and its status state. */
export type HeadScript = readonly [declaration: DeclaredScript, name: string | undefined,
  run: (loaded: boolean, event: Event) => void, read: () => ScriptStatus, write: (status: ScriptStatus) => void];

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  return typeof value === "object" ? "" : String(value);
}

/** A bound title segment: its text, or the text it last accepted when the result is invalid. */
export function headText(kept: unknown[], slot: number, value: unknown): string {
  if (value !== INVALID) kept[slot] = textOf(value);
  return (kept[slot] ?? "") as string;
}

/** A bound attribute: its value, null to leave it out, or the value it last accepted when the result is invalid. */
export function headAttribute(kept: unknown[], slot: number, value: unknown): string | null {
  if (value !== INVALID) {
    kept[slot] = value === null || value === undefined || value === false ? null : value === true ? ""
      : Array.isArray(value) ? value.map(textOf).join(" ") : typeof value === "object" ? null : String(value);
  }
  return (kept[slot] ?? null) as string | null;
}

/** A head element's attributes: an omitted value leaves its attribute out, and so does an executable URL. */
export function headAttributes(attributes: readonly (readonly [string, string | null])[]): [string, string][] {
  return attributes.flatMap(([name, value]): [string, string][] => value === null ||
    (name === "href" && /^(?:data|javascript|vbscript):/i.test(value.replace(/[\\u0000-\\u0020\\u007f]+/g, ""))) ? [] : [[name, value]]);
}

/** A bound JSON-LD block's text: the value as JSON with every < escaped, or null to leave it out. */
export function headJson(kept: unknown[], slot: number, value: unknown, source: string, definition: string): string | null {
  if (value !== INVALID) {
    if (value === null || value === undefined) kept[slot] = null;
    else if (typeof value === "object") kept[slot] = JSON.stringify(value).replaceAll("<", "\\\\u003c");
    else console.warn(definition + ": HR007: JSON-LD \`" + source + "\` must be an object or a list.");
  }
  return (kept[slot] ?? null) as string | null;
}

/** \`host.scripts\`: each named script's status, read from the component's own state, with \`ready\` and \`load()\`. */
function scriptResources(scripts: readonly HeadScript[], head: () => HeadInstance | undefined): Readonly<Record<string, unknown>> {
  const resources: Record<string, unknown> = {};
  for (const [, name, , read] of scripts) {
    if (name === undefined) continue;
    resources[name] = Object.freeze({
      get pending() { return read().pending; },
      get ok() { return read().ok; },
      get error() { return read().error; },
      get ready() { return head()?.scripts[name]!.ready ?? new Promise<void>(() => {}); },
      load: () => head()?.scripts[name]!.load() ?? new Promise<void>(() => {}),
    });
  }
  return Object.freeze(resources);
}

const eagerScripts = (scripts: readonly HeadScript[]): DeclaredScript[] =>
  scripts.flatMap(([declaration]) => declaration.loading === "eager" ? [declaration] : []);

/** The instance's scripts, calling the component's latest handlers and state writers. */
const instanceScripts = (scripts: () => readonly HeadScript[]): InstanceScript[] => scripts().map((script, index) =>
  [script[0], script[1], (loaded, event) => scripts()[index]![2](loaded, event), (status) => scripts()[index]![4](status)]);
`;

const ADAPTERS = {
  vue: `import { inject, provide, useSSRContext, watchEffect } from "vue";
import { useLifecycle } from "./host";
${HEAD_SOURCE}${FRAMEWORK_SOURCE}
const HEAD_DEPTH = Symbol.for("html-next:head-depth");
/** The server-rendering context key whose collector receives head declarations: \`renderToString(app, { [HEAD_CONTEXT]: collector })\`. */
export const HEAD_CONTEXT = "htmlNextHead";

/**
 * A component's head declarations while it is connected; \`compute\` evaluates them. In server
 * rendering they go to the collector in the render context. Returns \`host.scripts\`.
 */
export function useHead(componentRoot: { readonly value: any }, compute: () => readonly (HeadEntry | undefined)[], scripts: readonly HeadScript[] = []): Readonly<Record<string, unknown>> {
  const depth = inject<number>(HEAD_DEPTH, 0);
  provide(HEAD_DEPTH, depth + 1);
  if (typeof window === "undefined") {
    (useSSRContext() as Record<string, HeadCollector> | undefined)?.[HEAD_CONTEXT]?.contributions.push([depth, compute(), eagerScripts(scripts)]);
    return scriptResources(scripts, () => undefined);
  }
  const element = (): Element | undefined => {
    const value = componentRoot.value;
    return value == null ? undefined : value.nodeType === 1 ? value : value.$el;
  };
  const head = headInstance(element, instanceScripts(() => scripts));
  watchEffect(() => head.update(compute()));
  useLifecycle(componentRoot, () => head.connect(), () => head.disconnect());
  return scriptResources(scripts, () => head);
}
`,
  react: `import React from "react";
import { useLifecycle } from "./host";
${HEAD_SOURCE}${FRAMEWORK_SOURCE}
/** How many head-declaring components enclose this one, for server rendering, which has no document tree. */
export const HeadDepth = React.createContext(0);
let collecting: HeadCollector | undefined;

/** Server rendering: head declarations rendered inside \`render\` go to \`collector\`. */
export function collectHead<T>(collector: HeadCollector, render: () => T): T {
  const previous = collecting;
  collecting = collector;
  try { return render(); } finally { collecting = previous; }
}

/**
 * A component's head declarations while it is connected, \`entries\` evaluated on each render.
 * Returns \`host.scripts\` and the depth its markup provides to the components inside it.
 */
export function useHead(root: { readonly current: Element | null }, entries: readonly (HeadEntry | undefined)[], scripts: readonly HeadScript[] = []): readonly [Readonly<Record<string, unknown>>, number] {
  const depth = React.useContext(HeadDepth);
  const latest = React.useRef(scripts);
  latest.current = scripts;
  const head = React.useRef<HeadInstance | undefined>(undefined);
  if (typeof window === "undefined") {
    collecting?.contributions.push([depth, entries, eagerScripts(scripts)]);
  } else head.current ??= headInstance(() => root.current ?? undefined, instanceScripts(() => latest.current));
  React.useLayoutEffect(() => { head.current!.update(entries); });
  useLifecycle(root, () => head.current!.connect(), () => head.current!.disconnect());
  // \`host.scripts\` reads each status from the latest render's state.
  const resources = React.useMemo(() => scriptResources(scripts.map((script, index) =>
    [script[0], script[1], script[2], () => latest.current[index]![3](), script[4]] as const), () => head.current), []);
  return [resources, depth + 1];
}
`,
  svelte: `import { getContext, setContext } from "svelte";
import { useLifecycle } from "./connection.svelte";
${HEAD_SOURCE}${FRAMEWORK_SOURCE}
const HEAD_DEPTH = Symbol.for("html-next:head-depth");
/** The server-rendering context key whose collector receives head declarations: \`render(App, { context: new Map([[HEAD_CONTEXT, collector]]) })\`. */
export const HEAD_CONTEXT = "htmlNextHead";

/**
 * A component's head declarations while it is connected; \`compute\` evaluates them. In server
 * rendering they go to the collector in the render context. Returns \`host.scripts\`.
 */
export function useHead(root: () => Element | null, compute: () => readonly (HeadEntry | undefined)[], scripts: readonly HeadScript[] = []): Readonly<Record<string, unknown>> {
  const depth = getContext<number | undefined>(HEAD_DEPTH) ?? 0;
  setContext(HEAD_DEPTH, depth + 1);
  if (typeof window === "undefined") {
    getContext<HeadCollector | undefined>(HEAD_CONTEXT)?.contributions.push([depth, compute(), eagerScripts(scripts)]);
    return scriptResources(scripts, () => undefined);
  }
  const head = headInstance(() => root() ?? undefined, instanceScripts(() => scripts));
  $effect(() => head.update(compute()));
  useLifecycle(root, () => head.connect(), () => head.disconnect());
  return scriptResources(scripts, () => head);
}
`,
} as const;

export type HeadTarget = keyof typeof ADAPTERS;

/** Where each target's head helper sits, relative to its output root. */
export const HEAD_HELPER_PATHS: Readonly<Record<HeadTarget, string>> = { vue: "vue/head.ts", react: "react/head.ts", svelte: "svelte/head.svelte.ts" };

export function headHelperArtifact(target: HeadTarget, version: string): GeneratedArtifact {
  return Object.freeze({ path: HEAD_HELPER_PATHS[target], content: `// Generated by HTML Next ${version}. Do not edit.\n${ADAPTERS[target]}` });
}

/** Whether a definition adds anything to the document head, so its component imports the head helper. */
export function declaresHead(definition: ComponentDefinition): boolean {
  return definition.head !== undefined || definition.scripts !== undefined;
}

/**
 * A component's head declarations as one TypeScript array of entries, read through the target's
 * lowering: `value` gives an expression's value, the invalid-result symbol when it does not conform.
 */
export function headEntriesSource(definition: ComponentDefinition, value: (expression: CompiledExpression) => string, kept = "headKept"): string {
  let slot = 0;
  const entries = (definition.head ?? []).map((declaration): string => {
    if (declaration.kind === "title") {
      const parts = declaration.text.flatMap((node) => node.segments ?? [node]).map((segment) =>
        segment.expressionPlan === undefined ? quote(segment.value) : `headText(${kept}, ${slot++}, ${value(segment.expressionPlan)})`);
      return `["title", [], ${parts.length === 0 ? '""' : parts.join(" + ")}]`;
    }
    if (declaration.kind === "json") {
      if (declaration.value === undefined) return `["script", [["type", "application/ld+json"]], ${quote(declaration.text!)}]`;
      const text = `headJson(${kept}, ${slot++}, ${value(declaration.value)}, ${quote(declaration.value.source)}, ${quote(definition.source.file)})`;
      return `((text: string | null) => text === null ? undefined : ["script", [["type", "application/ld+json"]], text] as const)(${text})`;
    }
    return `[${quote(declaration.kind)}, headAttributes([${declaration.attributes.map((attribute) => attribute.kind === "literal"
      ? `[${quote(attribute.name)}, ${quote(attribute.value)}]`
      : `[${quote(attribute.name)}, headAttribute(${kept}, ${slot++}, ${value(attribute.expressionPlan!)})]`).join(", ")}])]`;
  });
  return `[${entries.join(", ")}] as readonly (HeadEntry | undefined)[]`;
}

/**
 * A component's declared scripts as `HeadScript`s: `handler` names a declared handler's call with the
 * event, and each named script reads and writes the status state `status` names.
 */
export function headScriptsSource(definition: ComponentDefinition, handler: (name: string, event: string) => string,
  status: (name: string) => { readonly read: string; readonly write: (value: string) => string }): string {
  return `[${(definition.scripts ?? []).map((script) => {
    const { load, error, name, ...attributes } = script;
    const declaration = `{ ...${JSON.stringify(attributes)} as Omit<DeclaredScript, "base" | "source">, base: ${quote(definition.source.file)}, source: ${quote(definition.source.file)} }`;
    // Parameters in the converters' own generated names, so a handler named `loaded` stays in scope.
    const run = `(htmlNextLoaded: boolean, htmlNextEvent: Event) => { ${load === undefined ? "" : `if (htmlNextLoaded) ${handler(load, "htmlNextEvent")};`}${load !== undefined && error !== undefined ? " else " : ""}${
      error === undefined ? "" : `${load === undefined ? "if (!htmlNextLoaded) " : ""}${handler(error, "htmlNextEvent")};`} }`;
    const state = name === undefined ? undefined : status(name);
    return `[${declaration}, ${name === undefined ? "undefined" : quote(name)}, ${run}, ${state === undefined ? "() => ({ pending: false, ok: false, error: null })" : `() => ${state.read}`}, ${
      state === undefined ? "() => {}" : `(status: ScriptStatus) => { ${state.write("status")}; }`}]`;
  }).join(", ")}] as readonly HeadScript[]`;
}
