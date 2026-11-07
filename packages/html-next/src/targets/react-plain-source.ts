import { REACT_PLAIN_NATIVE_SOURCE } from "./react-plain-native-source.js";

/** Feature-only plain projection support shared by React and Preact output. */
export const REACT_PLAIN_SOURCE = String.raw`
const emptyPlainFrames = /* @__PURE__ */ new Map<string, PlainFrame>();
type PlainSite = { anchor?: Comment; sourceStart?: Comment; boundary?: PlainBoundary; released?: boolean };
${REACT_PLAIN_NATIVE_SOURCE}
class PlainFrame {
  content: ReactNode;
  first?: PlainSite;
  current?: PlainSite;
  adopted = false;
  version = 0;
  readWrap?: () => ((content: ReactNode) => ReactNode) | undefined;
  readonly sites = new Set<PlainSite>();
  readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = (): number => this.version;
  #fragment?: DocumentFragment;
  #park?: DocumentFragment;
  #parent?: Node;
  #range?: { start: Comment; end: Comment };
  #source?: PlainBoundary;
  #host?: PlainBoundary;
  readonly #events: (readonly [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined])[] = [];

  constructor(content: ReactNode) { this.content = content; }
  source(): ReactNode {
    const content = markProjected(this.content), wrap = this.readWrap?.();
    return wrap === undefined ? content : wrap(content);
  }
  get fragment(): DocumentFragment {
    if (this.#fragment !== undefined) return this.#fragment;
    const fragment = this.#fragment = document.createDocumentFragment();
    const append = fragment.appendChild.bind(fragment);
    fragment.appendChild = <T extends Node>(node: T): T => {
      if (this.#range !== undefined) this.#range.end.before(node);
      else append(node);
      return node;
    };
    fragment.insertBefore = <T extends Node>(node: T, before: Node | null): T => {
      if (before !== null) before.parentNode!.insertBefore(node, before);
      else fragment.appendChild(node);
      return node;
    };
    (fragment as DocumentFragment & { moveBefore: typeof fragment.insertBefore }).moveBefore = fragment.insertBefore;
    fragment.removeChild = <T extends Node>(node: T): T => { node.parentNode!.removeChild(node); return node; };
    fragment.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
      this.#events.push([type, listener, options]);
      this.#parent?.addEventListener(type, listener, options);
    }) as typeof fragment.addEventListener;
    fragment.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void => {
      this.#parent?.removeEventListener(type, listener, options);
      const capture = typeof options === "boolean" ? options : options?.capture === true;
      for (let index = this.#events.length - 1; index >= 0; index -= 1) {
        const event = this.#events[index]!;
        const registered = typeof event[2] === "boolean" ? event[2] : event[2]?.capture === true;
        if (event[0] === type && event[1] === listener && registered === capture) this.#events.splice(index, 1);
      }
    }) as typeof fragment.removeEventListener;
    return fragment;
  }
  private nodes(): Node[] {
    const nodes: Node[] = [];
    for (let node: Node | null | undefined = this.#range?.start; node != null; node = node.nextSibling) {
      nodes.push(node); if (node === this.#range!.end) break;
    }
    return nodes;
  }
  private changed(): void { this.version++; for (const listener of this.listeners) listener(); }
  private listenAt(parent: Node | undefined): void {
    if (parent === this.#parent) return;
    for (const [type, listener, options] of this.#events) this.#parent?.removeEventListener(type, listener, options);
    this.#parent = parent;
    for (const [type, listener, options] of this.#events) this.#parent?.addEventListener(type, listener, options);
  }
  private select(next: PlainSite | undefined): void {
    const changed = this.current !== next;
    if (changed && this.current !== undefined) this.current.sourceStart = undefined;
    this.current = next;
    if (next !== undefined) next.sourceStart = this.#range?.start;
    if (this.#range !== undefined) {
      if (next?.anchor?.parentNode != null) {
        if (this.#range.end.nextSibling !== next.anchor) for (const node of this.nodes()) next.anchor.before(node);
      } else for (const node of this.nodes()) (this.#park ??= document.createDocumentFragment()).appendChild(node);
    }
    this.listenAt(this.#range?.end.parentNode ?? next?.anchor?.parentNode ?? undefined);
    if (changed) this.changed();
  }
  private choose(): void {
    queueMicrotask(() => {
      if (this.current?.boundary !== undefined && !this.current.released) return;
      const sites = [...this.sites].filter(site => !site.released && site.anchor?.parentNode != null);
      const connected = sites.filter(site => site.anchor!.isConnected);
      this.select((connected.length > 0 ? connected : sites).sort((left, right) => left.anchor!.compareDocumentPosition(right.anchor!) & 4 ? -1 : 1)[0]);
    });
  }
  private adopt(): void {
    if (this.adopted || this.#source === undefined || this.#host === undefined || this.first?.boundary === undefined) return;
    const owner = plainNativeOwner(this.#source);
    const nodes = plainNativeNodes(owner.node, owner.react);
    const first = nodes[0], last = nodes.at(-1);
    const placement = first?.parentNode == null ? plainNativePlacement(owner) : { parent: first.parentNode, before: first };
    const document = placement.parent.ownerDocument!;
    const start = document.createComment("html-next:plain-start"), end = document.createComment("html-next:plain-end");
    placement.parent.insertBefore(start, placement.before);
    if (last?.parentNode != null) last.parentNode.insertBefore(end, last.nextSibling);
    else placement.parent.insertBefore(end, placement.before);
    this.#range = { start, end };
    plainAdoptSource(this.#source, this.#host, this.fragment);
    this.adopted = true;
    this.select(this.first);
    this.changed();
  }
  readonly sourceReady = (boundary: PlainBoundary): void => { this.#source = boundary; this.adopt(); };
  readonly sourceGone = (): void => { this.#source = undefined; };
  readonly hostReady = (boundary: PlainBoundary): void => { this.#host = boundary; this.adopt(); };
  readonly hostGone = (): void => {
    const host = this.#host, source = this.#source;
    this.#host = undefined;
    queueMicrotask(() => {
      if (this.#host !== undefined) return;
      // Native Activity hides layout lifetimes while retaining the mounted subtree.
      if (host !== undefined && plainBoundaryMounted(host)) { this.#host = host; this.#source ??= source; return; }
      for (const [type, listener, options] of this.#events) this.#parent?.removeEventListener(type, listener, options);
      for (const node of this.nodes()) node.parentNode?.removeChild(node);
      this.#range = undefined; this.#source = undefined; this.#parent = undefined; this.#events.length = 0;
    });
  };
  place(site: PlainSite, boundary: PlainBoundary): void {
    site.boundary = boundary; site.released = false; this.sites.add(site);
    const owner = plainNativeOwner(boundary);
    const nodes = plainNativeNodes(owner.node, owner.react);
    const last = nodes.at(-1);
    const placement = last?.parentNode == null ? plainNativePlacement(owner) : { parent: last.parentNode, before: last.nextSibling };
    const anchor = site.anchor ??= placement.parent.ownerDocument!.createComment("html-next:plain-outlet");
    if (placement.before !== anchor && (anchor.parentNode !== placement.parent || anchor.nextSibling !== placement.before)) placement.parent.insertBefore(anchor, placement.before);
    if (this.current === site) this.select(site);
    this.adopt();
    if (this.adopted && this.current === undefined) this.choose();
  }
  release(site: PlainSite): void {
    site.boundary = undefined; site.released = true; this.sites.delete(site);
    if (this.current === site) {
      for (const node of this.nodes()) (this.#park ??= document.createDocumentFragment()).appendChild(node);
      this.listenAt(this.#range?.end.parentNode ?? undefined);
      this.choose();
    }
    site.anchor?.remove();
  }
}

function preparePlain(link: ChildLink): void {
  for (const [name, frame] of link.plain ?? []) frame.content = typeof link.slots?.[name] === "function" ? undefined : link.slots?.[name] as ReactNode;
  for (const [name, content] of Object.entries(link.slots ?? {})) {
    if (typeof content === "function") continue;
    const frames = link.plain ??= new Map();
    if (!frames.has(name)) { const frame = new PlainFrame(content as ReactNode); frame.readWrap = () => link.wrap; frames.set(name, frame); }
  }
}
function linkedPlain(link: ChildLink, name: string): PlainFrame | undefined { return link.plain?.get(name); }

/** The initially hydrated subtree joins this stable portal without remounting. */
function PlainHost(props: { readonly frame: PlainFrame }): ReactNode {
  const { frame } = props;
  React.useSyncExternalStore(frame.subscribe, frame.snapshot, frame.snapshot);
  const source = frame.adopted ? <PlainBoundary ready={frame.sourceReady} gone={frame.sourceGone}>{frame.source()}</PlainBoundary> : null;
  return <PlainBoundary ready={frame.hostReady} gone={frame.hostGone}>{typeof document === "undefined" ? null : createPortal(source, frame.fragment)}</PlainBoundary>;
}
function PlainLinkHost(props: { readonly link: ChildLink }): ReactNode {
  const { link } = props;
  React.useSyncExternalStore(link.subscribe, () => link.stamp, () => link.stamp);
  return <>{[...link.plain ?? []].map(([name, frame]) => <PlainHost key={name} frame={frame} />)}</>;
}
export function PlainChildren(props: { readonly entries: ReadonlyMap<string, object> }): ReactNode {
  return <>{[...props.entries.values()].map(entry => <PlainLinkHost key={identityKey(entry)} link={childLinks.get(entry)!} />)}</>;
}
export function usePlainSlots(link: ChildLink | undefined, props: { readonly children?: unknown; readonly slots?: Readonly<Record<string, unknown>> }, names: readonly string[]): {
  readonly frames: ReadonlyMap<string, PlainFrame>; readonly own: ReadonlyMap<string, PlainFrame>;
} {
  const kept = React.useRef<Map<string, PlainFrame> | undefined>(undefined);
  const own = names.length === 0 || link !== undefined ? emptyPlainFrames : kept.current ??= new Map();
  for (const name of link === undefined ? names : []) {
    const content = (name === "" ? props.children : props.slots?.[name]) as ReactNode;
    const frame = own.get(name);
    if (typeof content === "function") { if (frame !== undefined) frame.content = undefined; continue; }
    if (frame === undefined) own.set(name, new PlainFrame(content));
    else frame.content = content;
  }
  return { frames: link?.plain ?? own, own: link === undefined ? own : emptyPlainFrames };
}
export function PlainSlots(props: { readonly frames: ReadonlyMap<string, PlainFrame> }): ReactNode {
  return <>{[...props.frames].map(([name, frame]) => <PlainHost key={name} frame={frame} />)}</>;
}
/** Hydrate the first source in place, then retain it independently of its destination. */
export function PlainSlot(props: { readonly frame: PlainFrame | undefined; readonly content: ReactNode; readonly fallback: ReactNode }): ReactNode {
  const { frame, content, fallback } = props;
  const site = React.useRef<PlainSite>({}).current;
  React.useSyncExternalStore(frame?.subscribe ?? noSubscribe, frame?.snapshot ?? (() => 0), frame?.snapshot ?? (() => 0));
  const ready = React.useCallback((boundary: PlainBoundary): void => { frame?.place(site, boundary); }, [frame, site]);
  const gone = React.useCallback((): void => { frame?.release(site); }, [frame, site]);
  if (frame === undefined || typeof content === "function") return renderPlainSlot(content, fallback);
  frame.first ??= site;
  const first = frame.first === site;
  const filled = hasSlotContent(frame.content);
  return <PlainBoundary ready={ready} gone={gone} place={site}>
    {!frame.adopted && first ? <PlainBoundary ready={frame.sourceReady} gone={frame.sourceGone}>{filled ? frame.source() : null}</PlainBoundary> : null}
    {(frame.adopted ? frame.current === site : first) && filled ? null : fallback}
  </PlainBoundary>;
}
`;
