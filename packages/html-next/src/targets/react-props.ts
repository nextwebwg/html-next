import type { GeneratedArtifact } from "../generate.js";
import { typedPropsModule } from "./vue-props.js";

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

export function reactPropsArtifact(version: string): GeneratedArtifact {
  return Object.freeze({ path: "react/props.ts", content: `import React from "react";\n${typedPropsModule(version)}
/** Declared event details use the same nested type and constraint check as typed values. */
export function acceptsDeclaredEvent(value: unknown, type: Parameters<typeof parse>[1]): boolean {
  return parse(value, type, "$").ok;
}
${BOUNDARY}` });
}
