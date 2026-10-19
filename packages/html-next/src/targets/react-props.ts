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

export function reactPropsArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "react/props.ts", content: `import React from "react";\n${typedPropsModule(version)}
${DECLARED_EVENT_TYPE_SOURCE}${BOUNDARY}${INPUTS}` });
}
