/** Plain slot placement through Vue's supported component and ref APIs. */
export const VUE_PLAIN_SOURCE = String.raw`
interface SlotClaims { readonly claims: Map<string, object>; readonly released: Ref<number>; }
const newSlotClaims = (): SlotClaims => ({ claims: new Map(), released: shallowRef(0) });
const plainFilled = (nodes: readonly VNode[]): boolean => nodes.some(node => node.type === Fragment ? plainFilled(slotContent(node.children)) : node.type !== Comment);
/** Choose one destination; Vue creates and destroys each destination's ordinary subtree. */
const PlainPlacement = /* @__PURE__ */ defineComponent({
  props: { owner: { type: Object as PropType<SlotClaims>, required: true }, name: { type: String, default: "" }, read: { type: Function as PropType<() => VNode[]>, required: true } },
  setup(props, { slots }) {
    const site = {};
    onBeforeUnmount(() => {
      if (props.owner.claims.get(props.name) === site) {
        props.owner.claims.delete(props.name); props.owner.released.value++;
      }
    });
    return () => {
      const { owner, name } = props; void owner.released.value;
      const current = owner.claims.get(name);
      if (current !== undefined && current !== site) return slots.default?.();
      owner.claims.set(name, site);
      const content = props.read();
      return plainFilled(content) ? h(Fragment, content) : slots.default?.();
    };
  },
});
interface PlainSlots { readonly own: SlotClaims; readonly slots: Slots; readonly record: ChildRecord | undefined; }
const slotKey = (name: string): string => name === "" ? "default" : name;
export function usePlainSlots(_names: readonly string[], record?: ChildRecord): PlainSlots {
  const slots = useSlots(), own = newSlotClaims();
  onBeforeUpdate(() => { own.released.value++; });
  return { own, slots, record };
}
export const PlainSlot = /* @__PURE__ */ defineComponent({
  props: { state: { type: Object as PropType<PlainSlots>, required: true }, name: { type: String, default: "" } },
  setup(props, { slots }) {
    return () => {
      const { state, name } = props;
      const read = () => state.slots[slotKey(name)] === undefined ? [] : [renderChildSlot(state.slots, slotKey(name), {}, () => [])];
      if (state.slots[TEMPLATE_SLOT + slotKey(name)] !== undefined) return renderChildSlot(state.slots, slotKey(name), {}, () => slots.default?.() ?? []);
      return h(PlainPlacement, { owner: state.record ?? state.own, name, read }, slots);
    };
  },
});
`;
