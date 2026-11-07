/** Native subtree ownership used only by retained React/Preact projections. */
export const REACT_PLAIN_NATIVE_SOURCE = String.raw`
interface PlainNativeTree {
  tag?: number;
  type?: unknown;
  child?: PlainNativeTree | null;
  sibling?: PlainNativeTree | null;
  return?: PlainNativeTree | null;
  alternate?: PlainNativeTree | null;
  flags?: number;
  subtreeFlags?: number;
  lanes?: number;
  childLanes?: number;
  stateNode?: unknown;
  props?: { __P?: Node };
  __k?: (PlainNativeTree | null)[];
  __?: PlainNativeTree | null;
  __e?: Node | null;
  __c?: { __P?: Node; base?: Node | null } | null;
}
type PlainNativeOwner = { readonly node: PlainNativeTree; readonly react: boolean };
const PlainBoundary = /* @__PURE__ */ (() => class PlainBoundary extends React.Component<{
  readonly children?: ReactNode;
  readonly ready?: (boundary: PlainBoundary) => void;
  readonly gone?: () => void;
  readonly place?: PlainSite;
}> {
  declare _reactInternals?: PlainNativeTree;
  declare __v?: PlainNativeTree;
  componentDidMount(): void { this.props.ready?.(this); }
  componentDidUpdate(): void { this.props.ready?.(this); }
  componentWillUnmount(): void { this.props.gone?.(); }
  render(): ReactNode { return this.props.children; }
})();
type PlainBoundary = InstanceType<typeof PlainBoundary>;
function plainNativeOwner(boundary: PlainBoundary): PlainNativeOwner {
  const fiber = boundary._reactInternals;
  if (fiber === undefined) return { node: boundary.__v!, react: false };
  let root = fiber;
  while (root.return != null) root = root.return;
  const current = (root.stateNode as { current?: PlainNativeTree } | undefined)?.current;
  return { node: current === root || fiber.alternate == null ? fiber : fiber.alternate, react: true };
}
function plainBoundaryMounted(boundary: PlainBoundary): boolean {
  if (boundary._reactInternals === undefined) return boundary.__v?.__c?.__P != null;
  let root = boundary._reactInternals;
  while (root.return != null) root = root.return;
  const current = (root.stateNode as { current?: PlainNativeTree } | undefined)?.current;
  if (current === undefined) return false;
  const pending = [current];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.stateNode === boundary) return true;
    for (let child = node.child; child != null; child = child.sibling) pending.push(child);
  }
  return false;
}
function plainNativeChildren(node: PlainNativeTree, react: boolean): PlainNativeTree[] {
  if (!react) return (node.__k ?? []).filter((child): child is PlainNativeTree => child !== null);
  const children: PlainNativeTree[] = [];
  for (let child = node.child; child != null; child = child.sibling) children.push(child);
  return children;
}
function plainNativePortal(node: PlainNativeTree, react: boolean): boolean {
  return react ? node.tag === 4 : node.props?.__P !== undefined;
}
function plainNativeNodes(node: PlainNativeTree, react: boolean): Node[] {
  if (plainNativePortal(node, react)) return [];
  if (react && node.tag === 18) {
    // A deferred native hydration boundary already owns server DOM before its children have fibers.
    const nodes: Node[] = [];
    let depth = 0;
    for (let native: Node | null = node.stateNode as Node; native !== null; native = native.nextSibling) {
      nodes.push(native);
      if (native.nodeType !== 8 || native === node.stateNode) continue;
      const data = (native as Comment).data;
      if (data === "/$" || data === "/&") { if (depth === 0) break; depth--; }
      else if (["$", "$!", "$?", "$~", "&"].includes(data)) depth++;
    }
    return nodes;
  }
  if (react ? node.tag === 5 || node.tag === 6 : typeof node.type === "string" || node.type === null) {
    const native = react ? node.stateNode as Node | undefined : node.__e;
    return native == null ? [] : [native];
  }
  return plainNativeChildren(node, react).flatMap(child => plainNativeNodes(child, react));
}
function plainNativeFirst(node: PlainNativeTree, react: boolean): Node | undefined {
  if (plainNativePortal(node, react)) return undefined;
  const boundary = react ? node.stateNode : node.__c;
  if (boundary instanceof PlainBoundary && boundary.props.place?.anchor?.parentNode != null) {
    const site = boundary.props.place;
    return [plainNativeNodes(node, react)[0], site.sourceStart, site.anchor]
      .filter((candidate): candidate is Node => candidate != null && candidate.parentNode === site.anchor!.parentNode)
      .sort((left, right) => left.compareDocumentPosition(right) & 4 ? -1 : 1)[0];
  }
  if (react ? node.tag === 5 || node.tag === 6 || node.tag === 18 : typeof node.type === "string" || node.type === null) return plainNativeNodes(node, react)[0];
  for (const child of plainNativeChildren(node, react)) {
    const first = plainNativeFirst(child, react);
    if (first !== undefined) return first;
  }
  return undefined;
}
function plainNativePlacement(owner: PlainNativeOwner): { readonly parent: Node; readonly before: Node | null } {
  let node = owner.node;
  for (;;) {
    const parent = owner.react ? node.return : node.__;
    if (parent == null) throw new Error("A plain slot has no native parent.");
    const siblings = plainNativeChildren(parent, owner.react);
    for (let index = siblings.indexOf(node) + 1; index < siblings.length; index++) {
      const before = plainNativeFirst(siblings[index]!, owner.react);
      if (before?.parentNode != null) return { parent: before.parentNode, before };
    }
    if (owner.react ? parent.tag === 5 : typeof parent.type === "string") {
      return { parent: (owner.react ? parent.stateNode : parent.__e) as Node, before: null };
    }
    if (plainNativePortal(parent, owner.react) || owner.react && parent.tag === 3) {
      return { parent: (owner.react ? (parent.stateNode as { containerInfo: Node }).containerInfo : parent.props!.__P!) as Node, before: null };
    }
    node = parent;
  }
}
function plainAdoptSource(source: PlainBoundary, host: PlainBoundary, container: Node): void {
  const from = plainNativeOwner(source), to = plainNativeOwner(host);
  const portal = plainNativeChildren(to.node, to.react).find(node => plainNativePortal(node, to.react));
  if (portal === undefined || from.react !== to.react) throw new Error("A retained plain source has no native portal owner.");
  if (from.react) {
    const parent = from.node.return!;
    if (parent.child === from.node) parent.child = from.node.sibling;
    else {
      let previous = parent.child;
      while (previous != null && previous.sibling !== from.node) previous = previous.sibling;
      if (previous == null) throw new Error("A retained plain source is detached from its native parent.");
      previous.sibling = from.node.sibling;
    }
    from.node.sibling = null;
    from.node.return = portal;
    portal.child = from.node;
    // React's commit traversal follows aggregate effects and pending work on the destination path.
    const flags = (from.node.flags ?? 0) | (from.node.subtreeFlags ?? 0);
    const lanes = (from.node.lanes ?? 0) | (from.node.childLanes ?? 0);
    for (let owner: PlainNativeTree | null | undefined = portal; owner != null; owner = owner.return) {
      owner.subtreeFlags = (owner.subtreeFlags ?? 0) | flags;
      owner.childLanes = (owner.childLanes ?? 0) | lanes;
    }
    return;
  }
  const parent = from.node.__!;
  parent.__k = parent.__k!.map(child => child === from.node ? null : child);
  from.node.__ = portal;
  portal.__k = [from.node];
  const reparent = (node: PlainNativeTree): void => {
    if (node.__c != null) node.__c.__P = container;
    if (typeof node.type !== "string" && !plainNativePortal(node, false)) for (const child of plainNativeChildren(node, false)) reparent(child);
  };
  reparent(from.node);
  for (let node: PlainNativeTree | null | undefined = parent; node != null && typeof node.type !== "string" && !plainNativePortal(node, false); node = node.__) {
    node.__e = plainNativeNodes(node, false)[0] ?? null;
    if (node.__c != null) node.__c.base = node.__e;
  }
}
`;
