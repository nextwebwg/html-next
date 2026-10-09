/**
 * The rendering module converted React components share: the helpers their markup renders and
 * binds values with, and the checks their handlers write through. They are the same for every
 * component, so they ship once beside the components rather than inside each one; a bundler keeps
 * only the ones a component imports. It depends on React alone.
 */
import type { GeneratedArtifact } from "../generate.js";
import { HOST_STATE_TOKENS_SOURCE } from "./host-state-source.js";
import { formatReact } from "./vue-format.js";
import { expressionHelpersSource } from "./vue-lowering.js";

/** Where the module sits, relative to the package root, and how a component imports it. */
export const REACT_RENDER_PATH = "react/render.tsx";
export const REACT_RENDER_SPECIFIER = "./render";

/** What a component may import from the module, by the name its generated code calls. */
export const REACT_RENDER_EXPORTS = [
  "warnUnless", "acceptsWrite", "isString", "isNumber", "isInteger", "isBoolean",
  "truthy", "text", "attribute", "list", "number", "concat", "join", "math", "arithmetic", "sortBy", "eachRows", "uniqueKeys", "formatValue",
  "RetainedText", "RetainedValue", "OutputValue", "cycleCheckedComputed", "KeyedBoundary", "hostStateTokens",
  "renderPlainSlot", "renderScopedSlot", "markProjected", "writeStatePath", "useLiveState",
] as const;

const SOURCE = `import React from "react";
import type { ReactNode } from "react";

${expressionHelpersSource()}

/**
 * React state a handler reads and writes in step order, as HTML Next handlers do: a write is the
 * next read's value at once, before React renders it. The setter takes a value or an updater.
 */
export function useLiveState<T>(initial: T): readonly [T, (next: T | ((previous: T) => T)) => void, () => T] {
  const [value, setValue] = React.useState<T>(initial);
  const latest = React.useRef(value);
  React.useLayoutEffect(() => { latest.current = value; });
  const set = React.useCallback((next: T | ((previous: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(latest.current) : next;
    latest.current = resolved;
    setValue(() => resolved);
  }, []);
  const get = React.useCallback(() => latest.current, []);
  return [value, set, get];
}

/** Text that keeps its last accepted value while an expression is invalid. */
export function RetainedText({ value, text, accepts }: { readonly value: unknown; readonly text: string; readonly accepts?: () => boolean }): ReactNode {
  const accepted = value !== Symbol.for("html-next.invalid-result") && (accepts?.() ?? true);
  const last = React.useRef(accepted ? text : "");
  React.useLayoutEffect(() => { if (accepted) last.current = text; }, [accepted, text]);
  return accepted ? text : last.current;
}

/** A value that keeps its last accepted value while an expression is invalid, rendered through \`render\`. */
export function RetainedValue({ value, accepts, render }: { readonly value: unknown; readonly accepts?: (value: unknown) => boolean; readonly render: (value: any, hasValue: boolean) => ReactNode }): ReactNode {
  const accepted = value !== Symbol.for("html-next.invalid-result") && (accepts === undefined ? value !== undefined : accepts(value));
  const last = React.useRef<{ value: unknown; hasValue: boolean }>({ value: undefined, hasValue: false });
  React.useLayoutEffect(() => { if (accepted) last.current = { value, hasValue: true }; }, [accepted, value]);
  return render(accepted ? value : last.current.value, accepted || last.current.hasValue);
}

/** An \`<output>\` whose text React and the form's own resets both write, kept in step. */
export function OutputValue({ htmlNextValue, htmlNextText, htmlNextRetain, htmlNextAccepts = true, ref, ...attrs }: React.OutputHTMLAttributes<HTMLOutputElement> & { readonly htmlNextValue: unknown; readonly htmlNextText: string; readonly htmlNextRetain: boolean; readonly htmlNextAccepts?: boolean; readonly ref?: React.Ref<HTMLOutputElement> }): ReactNode {
  const accepted = !htmlNextRetain || (htmlNextValue !== undefined && htmlNextValue !== Symbol.for("html-next.invalid-result") && htmlNextAccepts);
  const last = React.useRef(accepted ? htmlNextText : "");
  const output = React.useRef<HTMLOutputElement | null>(null);
  const attach = React.useCallback((element: HTMLOutputElement | null) => {
    output.current = element;
    if (typeof ref === "function") {
      const cleanup = ref(element);
      return () => { output.current = null; if (typeof cleanup === "function") cleanup(); else ref(null); };
    }
    if (ref != null) (ref as { current: HTMLOutputElement | null }).current = element;
    return () => { output.current = null; if (ref != null) (ref as { current: HTMLOutputElement | null }).current = null; };
  }, [ref]);
  const shown = accepted ? htmlNextText : last.current;
  React.useLayoutEffect(() => {
    if (accepted) last.current = htmlNextText;
    if (output.current !== null && output.current.textContent !== shown) output.current.textContent = shown;
  });
  return <output {...attrs} ref={attach}>{shown}</output>;
}

/** A computed value; reading it while it computes is a cycle (HR006). */
export function cycleCheckedComputed<T>(evaluate: () => T, cache = true): { get(): T } {
  let reading = false;
  let ready = false;
  let cached!: T;
  return { get() {
    if (reading) {
      const message = "A reactive computed value depends on itself.";
      throw Object.assign(new Error(\`HR006: \${message}\`), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR006", message }) });
    }
    if (!cache || !ready) {
      reading = true;
      try { cached = evaluate(); ready = true; } finally { reading = false; }
    }
    return cached;
  } };
}

type KeyedRowsRender = () => ReactNode;
interface KeyedBoundaryState { readonly failed: boolean; readonly renderRows: KeyedRowsRender; }

/** A keyed list that produces a duplicate key (HR004) keeps its last committed rows. */
export class KeyedBoundary extends React.Component<{ readonly renderRows: KeyedRowsRender }, KeyedBoundaryState> {
  state: KeyedBoundaryState = { failed: false, renderRows: this.props.renderRows };
  private lastCommittedRender: KeyedRowsRender | undefined;
  static getDerivedStateFromProps(props: { readonly renderRows: KeyedRowsRender }, state: KeyedBoundaryState): Partial<KeyedBoundaryState> | null {
    return props.renderRows === state.renderRows ? null : { failed: false, renderRows: props.renderRows };
  }
  static getDerivedStateFromError(error: unknown): Partial<KeyedBoundaryState> {
    if ((error as { diagnostic?: { code?: string } } | null)?.diagnostic?.code !== "HR004") throw error;
    return { failed: true };
  }
  componentDidMount(): void { this.lastCommittedRender = this.props.renderRows; }
  componentDidUpdate(): void { if (!this.state.failed) this.lastCommittedRender = this.props.renderRows; }
  render(): ReactNode {
    return <KeyedRows renderRows={this.state.failed ? this.lastCommittedRender ?? (() => null) : this.props.renderRows} />;
  }
}
function KeyedRows(props: { readonly renderRows: KeyedRowsRender }): ReactNode { return props.renderRows(); }

export ${HOST_STATE_TOKENS_SOURCE.trim()}

/** A plain slot's content, or its fallback when the consumer passed none. */
export function renderPlainSlot(slot: ReactNode | ((props: Record<string, any>) => ReactNode) | undefined, fallback: ReactNode): ReactNode {
  if (typeof slot === "function") return null;
  return hasSlotContent(slot) ? markProjected(slot) : fallback;
}

function hasSlotContent(value: ReactNode): boolean {
  if (value == null || typeof value === "boolean" || value === "") return false;
  if (Array.isArray(value)) return value.some(hasSlotContent);
  if (React.isValidElement(value) && value.type === React.Fragment) {
    return hasSlotContent((value.props as { children?: ReactNode }).children);
  }
  return true;
}

/** A scoped slot rendered with its values; plain children cannot fill it (HR007). */
export function renderScopedSlot<T extends Record<string, unknown>>(slot: ReactNode | ((props: T) => ReactNode) | undefined, values: T, name: string, fallback: ReactNode): ReactNode {
  if (slot === undefined) return fallback;
  if (typeof slot !== "function") {
    const message = "Scoped slot \`" + name + "\` requires a consumer <template slot=\\"" + name + "\\">.";
    throw Object.assign(new Error(\`HR007: \${message}\`), { name: "HtmlDiagnosticError", diagnostic: Object.freeze({ code: "HR007", message }) });
  }
  return markProjected(slot(values));
}

/** Projected elements carry \`data-slotted\`, which the component's \`:slotted()\` rules select. */
export function markProjected(value: ReactNode): ReactNode {
  if (Array.isArray(value)) return value.map(markProjected);
  if (!React.isValidElement(value)) return value;
  if (value.type === React.Fragment) return React.cloneElement(value, {}, markProjected((value.props as { children?: ReactNode }).children));
  return React.cloneElement(value as React.ReactElement<Record<string, unknown>>, { "data-slotted": "" });
}

/** A copy of a state value with one nested path written, or the same value when nothing changes. */
export function writeStatePath<T>(root: T, path: readonly unknown[], value: unknown): T {
  if (root === null || typeof root !== "object") return root;
  const result = Array.isArray(root) ? root.slice() : { ...root };
  let source: unknown = root;
  let target: unknown = result;
  for (const [index, segment] of path.entries()) {
    if (typeof segment !== "string" && typeof segment !== "number") return root;
    if (index === path.length - 1) {
      if (Object.is((source as Record<string | number, unknown>)[segment], value)) return root;
      (target as Record<string | number, unknown>)[segment] = value;
    }
    else {
      const next = (source as Record<string | number, unknown>)[segment];
      if (next === null || typeof next !== "object") return root;
      const copy = Array.isArray(next) ? next.slice() : { ...next };
      (target as Record<string | number, unknown>)[segment] = copy;
      source = next; target = copy;
    }
  }
  return result as T;
}
`;

export function reactRenderArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: REACT_RENDER_PATH, content: formatReact(`// Generated by HTML Next ${version} for React 19. Do not edit.\n${SOURCE}`, "render.tsx") });
}
