/** Plain projection lifetime through Vue's Teleport renderer hooks. */
export const VUE_PLAIN_SOURCE = String.raw`
interface PlainSite { vnode?: VNode; }
class PlainFrame {
  owner: PlainSite | undefined;
  current: VNode | undefined;
  cached: VNode | undefined;
  retired = false;
  readonly sites = new Set<PlainSite>();
  readonly revision = shallowRef(0);
  private park?: DocumentFragment;
  private container?: DocumentFragment;
  private internals: any;
  private parent: any;
  private suspense: any;
  private stop?: () => void;
  constructor(readonly read: () => VNode[]) {}
  nodes(): Node[] {
    if (this.current === undefined) return [...this.park?.childNodes ?? []];
    const nodes: Node[] = [];
    for (let node = this.current.el!.nextSibling; node !== null && node !== this.current.anchor; node = node.nextSibling) nodes.push(node);
    return nodes;
  }
  target(): DocumentFragment {
    if (this.container !== undefined) return this.container;
    const fragment = this.container = document.createDocumentFragment();
    fragment.insertBefore = <T extends Node>(node: T, before: Node | null): T => {
      if (before !== null) before.parentNode!.insertBefore(node, before);
      else if (this.current !== undefined) this.current.anchor!.parentNode!.insertBefore(node, this.current.anchor!);
      else (this.park ??= document.createDocumentFragment()).appendChild(node);
      return node;
    };
    return fragment;
  }
  remember(vnode: VNode, parent: any, suspense: any, internals: any): void {
    this.cached = vnode; this.current = vnode;
    this.parent = parent; this.suspense = suspense; this.internals = internals;
  }
  release(vnode: VNode): void {
    if (this.current !== vnode) return;
    const nodes = this.nodes(); this.current = undefined;
    const park = this.park ??= document.createDocumentFragment();
    for (const node of nodes) park.appendChild(node);
    this.owner = undefined;
    this.choose();
  }
  choose(): void {
    if (this.retired) return;
    if (this.owner?.vnode?.el?.isConnected === true) return;
    if (this.current !== undefined) this.release(this.current);
    queueMicrotask(() => {
      if (this.retired || this.owner !== undefined) return;
      this.owner = [...this.sites].filter(site => site.vnode?.el?.isConnected === true)
        .sort((left, right) => left.vnode!.el!.compareDocumentPosition(right.vnode!.el!) & 4 ? -1 : 1)[0];
      this.revision.value++;
    });
  }
  observe(site: PlainSite): void {
    const parent = site.vnode?.el?.parentElement;
    if (this.stop === undefined && parent != null) this.stop = observeConnection(parent, () => this.choose());
  }
  dispose(): void {
    if (this.retired) return;
    this.retired = true; this.stop?.(); this.sites.clear(); this.owner = undefined;
    if (this.cached !== undefined) {
      for (const node of this.cached.children as VNode[]) this.internals.um(node, this.parent, this.suspense, true);
      this.cached.children = []; this.cached = undefined;
    }
  }
}
// Vue's server renderer recognizes the Teleport shape and emits its normal inline hydration marks.
// These hooks retain the children when a destination disappears; Vue still owns their patching and disposal.
const PlainPortal = /* @__PURE__ */ (() => {
  const base = Teleport as any;
  return { ...base,
    process(n1: any, n2: any, container: any, anchor: any, parent: any, suspense: any, namespace: any, scopes: any, optimized: any, internals: any): void {
      const { frame, site, active } = n2.props as { frame: PlainFrame; site: PlainSite; active: boolean };
      const args = [container, anchor, parent, suspense, namespace, scopes, optimized, internals];
      if (n1 !== null && n1.props.active !== active) {
        args[1] = n1.anchor.nextSibling;
        PlainPortal.remove(n1, parent, suspense, internals, true);
        n1.el?.parentNode?.removeChild(n1.el); n1 = null;
      }
      if (!active) { base.process(n1, n2, ...args); site.vnode = n2; return; }
      const nodes = frame.current?.anchor === n1?.anchor && n1 !== null ? [] : frame.nodes();
      if (n1 === null) {
        const empty = { ...n2, children: [] };
        base.process(null, empty, ...args);
        n2.el = empty.el; n2.anchor = empty.anchor; n2.target = empty.target;
        n2.targetStart = empty.targetStart; n2.targetAnchor = empty.targetAnchor;
      } else {
        n2.el = n1.el; n2.anchor = n1.anchor; n2.target = n1.target;
        n2.targetStart = n1.targetStart; n2.targetAnchor = n1.targetAnchor;
      }
      frame.current = n2; site.vnode = n2;
      for (const node of nodes) n2.anchor.parentNode!.insertBefore(node, n2.anchor);
      if (frame.cached !== undefined) internals.pc(frame.cached, n2, frame.target(), null, parent, suspense, namespace, scopes, false);
      else internals.mc(n2.children, frame.target(), null, parent, suspense, namespace, scopes, false);
      frame.remember(n2, parent, suspense, internals);
    },
    hydrate(node: any, vnode: any, parent: any, suspense: any, scopes: any, optimized: any, internals: any, hydrateChildren: any): any {
      const next = base.hydrate(node, vnode, parent, suspense, scopes, optimized, internals, hydrateChildren);
      const { frame, site, active } = vnode.props as { frame: PlainFrame; site: PlainSite; active: boolean };
      site.vnode = vnode;
      if (active) frame.remember(vnode, parent, suspense, internals);
      return next;
    },
    remove(vnode: any, parent: any, suspense: any, internals: any, doRemove: boolean): void {
      const { frame, active } = vnode.props as { frame: PlainFrame; active: boolean };
      if (!active) { base.remove(vnode, parent, suspense, internals, doRemove); return; }
      frame.release(vnode);
      for (const node of [vnode.el, vnode.anchor, vnode.targetStart, vnode.targetAnchor]) node?.parentNode?.removeChild(node);
    },
  };
})();
const plainFilled = (nodes: readonly VNode[]): boolean => nodes.some(node => node.type === Fragment ? plainFilled(slotContent(node.children)) : node.type !== Comment);
const PlainPlacement = /* @__PURE__ */ defineComponent({
  props: { frame: { type: Object as PropType<PlainFrame>, required: true } },
  setup(props, { slots }) {
    const site: PlainSite = {};
    props.frame.sites.add(site);
    onMounted(() => props.frame.observe(site));
    onBeforeUnmount(() => { props.frame.sites.delete(site); });
    return () => {
      const frame = props.frame; void frame.revision.value;
      if (frame.retired) return slots.default?.();
      if (frame.owner === undefined && (typeof document === "undefined" || site.vnode === undefined || site.vnode.el?.isConnected === true)) frame.owner = site;
      const active = frame.owner === site;
      const content = active ? frame.read() : [];
      return h(Fragment, [h(PlainPortal as any, { frame, site, active, disabled: true, to: typeof document === "undefined" ? "#html-next-plain" : frame.target() }, content),
        !active || !plainFilled(content) ? slots.default?.() : null]);
    };
  },
});
interface PlainSlots { readonly own: Map<string, PlainFrame>; readonly slots: Slots; readonly record: ChildRecord | undefined; }
const slotKey = (name: string): string => name === "" ? "default" : name;
function plainFrame(record: ChildRecord, name: string): PlainFrame {
  let frame = record.plain.get(name);
  if (frame === undefined) {
    frame = new PlainFrame(() => {
      const given = record.read().children as Slots | null;
      return given?.[slotKey(name)] === undefined ? [] : [renderChildSlot(given, slotKey(name), {}, () => [])];
    });
    record.plain.set(name, frame);
  }
  return frame;
}
export function usePlainSlots(names: readonly string[], record?: ChildRecord): PlainSlots {
  const slots = useSlots(), own = new Map<string, PlainFrame>();
  if (record === undefined) for (const name of names) own.set(name, new PlainFrame(() => slots[slotKey(name)] === undefined ? [] : [renderChildSlot(slots, slotKey(name), {}, () => [])]));
  onBeforeUpdate(() => { for (const frame of own.values()) frame.revision.value++; });
  onBeforeUnmount(() => { for (const frame of own.values()) frame.dispose(); });
  return { own, slots, record };
}
export const PlainSlot = /* @__PURE__ */ defineComponent({
  props: { state: { type: Object as PropType<PlainSlots>, required: true }, name: { type: String, default: "" } },
  setup(props, { slots }) {
    return () => {
      const { state, name } = props;
      if (state.slots[TEMPLATE_SLOT + slotKey(name)] !== undefined) return renderChildSlot(state.slots, slotKey(name), {}, () => slots.default?.() ?? []);
      const frame = state.record === undefined ? state.own.get(name) : plainFrame(state.record, name);
      return frame === undefined ? renderChildSlot(state.slots, slotKey(name), {}, () => slots.default?.() ?? []) : h(PlainPlacement, { frame }, slots);
    };
  },
});
`;
