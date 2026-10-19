import type { GeneratedArtifact } from "../generate.js";
import { typedPropsModule } from "./vue-props.js";
import { DECLARED_EVENT_TYPE_SOURCE } from "./shared-generated.js";

const BOUNDARY = `interface PropBoundaryProps<P> {
  readonly value: P;
  readonly render: (value: P) => React.ReactNode;
}
interface PropBoundaryState<P> { readonly failed: boolean; readonly value: P; }

/** Preserve the last valid component output when a later typed prop is rejected. */
export class PropBoundary<P> extends React.Component<PropBoundaryProps<P>, PropBoundaryState<P>> {
  state: PropBoundaryState<P> = { failed: false, value: this.props.value };
  private lastCommittedValue: P | undefined;

  static getDerivedStateFromProps<P>(props: PropBoundaryProps<P>, state: PropBoundaryState<P>): Partial<PropBoundaryState<P>> | null {
    return props.value === state.value ? null : { failed: false, value: props.value };
  }

  static getDerivedStateFromError(error: unknown): { failed: true } {
    if ((error as { diagnostic?: { code?: string } } | null)?.diagnostic?.code !== "HR002") throw error;
    return { failed: true };
  }

  componentDidMount(): void {
    if (!this.state.failed) this.lastCommittedValue = this.props.value;
  }

  componentDidUpdate(): void {
    if (!this.state.failed) this.lastCommittedValue = this.props.value;
  }

  render(): React.ReactNode {
    if (this.state.failed && this.lastCommittedValue === undefined) return null;
    return this.props.render(this.state.failed ? this.lastCommittedValue! : this.props.value);
  }
}
`;

const INPUTS = `
export function usePropInputs(values: Record<string, unknown>, defaults: Readonly<Record<string, unknown>>,
  check: PropInputOptions["check"]): PropInputs {
  const ref = React.useRef<{ inputs: PropInputs; revision: number; listeners: Set<() => void> } | undefined>(undefined);
  if (ref.current === undefined) {
    ref.current = { revision: 0, listeners: new Set(), inputs: new PropInputs({ names: Object.keys(values), values, defaults, check,
      invalidate: () => { ref.current!.revision += 1; for (const notify of ref.current!.listeners) notify(); } }) };
  }
  const current = ref.current;
  React.useSyncExternalStore(React.useCallback(notify => { current.listeners.add(notify); return () => { current.listeners.delete(notify); }; }, [current]),
    () => current.revision, () => current.revision);
  const candidate = current.inputs.fork({ names: Object.keys(values), values, defaults, check,
    invalidate: () => { current.revision += 1; for (const notify of current.listeners) notify(); } });
  React.useLayoutEffect(() => { current.inputs.commit(candidate); });
  return candidate;
}
`;

const INITIALIZED_STATE = `
interface InitializedState<T> {
  get(): T | null | undefined;
  status(): InputStatus;
  read(): T | null | undefined;
  readStatus(): InputStatus;
  subscribe(notify: () => void): () => void;
  assign(next: T | null | undefined): void;
  touch(): void;
  set(next: T | null | undefined | ((previous: T | null | undefined) => T | null | undefined), path?: readonly unknown[]): void;
}
/** A render may preview a seed; only an imperative read, accepted write or committed render owns it. */
export function useInitializedState<T>(evaluate: () => { value: unknown; status: InputStatus }, committed: () => { value: unknown; status: InputStatus },
  accepts: (value: unknown) => boolean, computed: <V>(evaluate: () => V, cache?: boolean) => { get(): V },
  written?: unknown[][], name?: string, dependencies: readonly { readonly subscribe?: (notify: () => void) => () => void }[] = []): InitializedState<T> {
  const ref = React.useRef<{
    revision: number; initialized: boolean; value: T | null | undefined; statusValue: InputStatus; stops: Set<() => void>;
    evaluate: typeof committed; listeners: Set<() => void>; read(): T | null | undefined;
    status(): InputStatus; set: InitializedState<T>["set"]; assign: InitializedState<T>["assign"]; touch(): void;
  } | undefined>(undefined);
  if (ref.current === undefined) {
    const listeners = new Set<() => void>();
    const current = {
      revision: 0, initialized: false, value: undefined as T | null | undefined, statusValue: UNRESOLVED_INPUT, stops: new Set<() => void>(), evaluate: committed, listeners,
      read(): T | null | undefined {
        if (!current.initialized) {
          const next = seed.get();
          if (next.status.ready && !next.status.stale && next.value !== undefined && accepts(next.value)) {
            current.initialized = true; current.value = copyStateSeed(next.value) as T;
            for (const stop of current.stops) stop(); current.stops.clear();
            changed();
          } else {
            const status = { ...next.status, ready: false, stale: false };
            if (!sameInputStatus(current.statusValue, status)) { current.statusValue = status; changed(); }
          }
        }
        return current.value;
      },
      status(): InputStatus { current.read(); return current.initialized ? READY_INPUT : current.statusValue; },
      assign(next: T | null | undefined): void { write(next, []); },
      touch(): void { changed(); },
      set(next: T | null | undefined | ((previous: T | null | undefined) => T | null | undefined), path: readonly unknown[] = []): void {
        const previous = typeof next === "function" ? current.read() : current.value;
        const resolved = typeof next === "function" ? (next as (previous: T | null | undefined) => T | null | undefined)(previous) : next;
        // An updater cannot write below an absent root. An explicit root assignment can claim null.
        if (!current.initialized && previous === undefined && resolved === undefined && typeof next === "function") return;
        write(resolved, path);
      },
    };
    function write(next: T | null | undefined, path: readonly unknown[]): void {
      if (next != null && !accepts(next)) return;
      const first = !current.initialized, previous = current.value;
      current.initialized = true; current.value = next ?? null;
      for (const stop of current.stops) stop(); current.stops.clear();
      if (first || !Object.is(previous, current.value)) {
        if (written !== undefined) written.push([name, ...path]);
        changed();
      }
    }
    function changed(): void { current.revision++; for (const notify of listeners) notify(); }
    const seed = computed(() => current.evaluate(), false);
    ref.current = current;
  }
  const current = ref.current;
  const subscribe = React.useCallback((notify: () => void) => { current.listeners.add(notify); return () => { current.listeners.delete(notify); }; }, [current]);
  const base = React.useSyncExternalStore(subscribe, () => current.revision, () => current.revision);
  const candidate = computed(() => {
    if (current.initialized) return { value: current.value, status: READY_INPUT };
    const next = evaluate();
    return next.status.ready && !next.status.stale && next.value !== undefined && accepts(next.value)
      ? { value: copyStateSeed(next.value) as T, status: READY_INPUT }
      : { value: undefined, status: { ...next.status, ready: false, stale: false } };
  });
  React.useLayoutEffect(() => {
    current.evaluate = committed;
    if (current.revision === base && !current.initialized) current.read();
  });
  React.useEffect(() => {
    if (current.initialized) return;
    let active = true;
    const stops = dependencies.flatMap(dependency => dependency.subscribe === undefined ? [] : [dependency.subscribe(() => { queueMicrotask(() => { if (active) current.read(); }); })]);
    for (const stop of stops) current.stops.add(stop);
    current.read();
    return () => { active = false; for (const stop of stops) { stop(); current.stops.delete(stop); } };
  }, dependencies);
  return { get: () => candidate.get().value, status: () => candidate.get().status,
    read: current.read, readStatus: current.status, subscribe, set: current.set, assign: current.assign, touch: current.touch };
}
`;

export function reactPropsArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "react/props.ts", content: `import React from "react";\n${typedPropsModule(version)}
${DECLARED_EVENT_TYPE_SOURCE}${BOUNDARY}${INPUTS}${INITIALIZED_STATE}` });
}
