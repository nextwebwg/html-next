/** Feature-only plain projection support shared by React and Preact output. */
export const REACT_PLAIN_SOURCE = String.raw`
const emptyPlainFrames = /* @__PURE__ */ new Map<string, PlainFrame>();
type PlainSite = { readonly start: Comment; readonly end: Comment };
class PlainFrame {
  content: ReactNode;
  serverOwner?: object;
  current?: PlainSite;
  version = 0;
  readonly sites = new Set<PlainSite>();
  readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = (): number => this.version;
  #fragment?: DocumentFragment;
  #park?: DocumentFragment;
  #parent?: Node;
  readonly #events: (readonly [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined])[] = [];

  constructor(content: ReactNode) { this.content = content; }
  get fragment(): DocumentFragment {
    if (this.#fragment !== undefined) return this.#fragment;
    const fragment = this.#fragment = document.createDocumentFragment();
    const append = fragment.appendChild.bind(fragment);
    fragment.appendChild = <T extends Node>(node: T): T => {
      if (this.current !== undefined) this.current.end.before(node);
      else if (this.#park?.firstChild != null) this.#park.append(node);
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
    if (this.current === undefined) return [...this.#park?.childNodes ?? [], ...this.#fragment?.childNodes ?? []];
    const nodes: Node[] = [];
    for (let node = this.current.start.nextSibling; node !== null && node !== this.current.end; node = node.nextSibling) nodes.push(node);
    return nodes;
  }
  private select(next: PlainSite | undefined): void {
    const nodes = this.nodes();
    for (const [type, listener, options] of this.#events) this.#parent?.removeEventListener(type, listener, options);
    this.current = next;
    this.#parent = next?.end.parentNode ?? undefined;
    if (next !== undefined) next.end.before(...nodes);
    else (this.#park ??= document.createDocumentFragment()).append(...nodes);
    for (const [type, listener, options] of this.#events) this.#parent?.addEventListener(type, listener, options);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
  attach(template: HTMLTemplateElement, site: PlainSite): () => void {
    template.replaceWith(site.start, site.end);
    this.sites.add(site);
    if (this.current === undefined) this.select(site);
    return () => {
      this.sites.delete(site);
      if (this.current === site) this.select([...this.sites].filter(site => site.start.isConnected)
        .sort((left, right) => left.start.compareDocumentPosition(right.start) & 4 ? -1 : 1)[0]);
      site.start.before(template);
      site.start.remove(); site.end.remove();
    };
  }
}

function preparePlain(link: ChildLink): void {
  for (const [name, frame] of link.plain ?? []) frame.content = typeof link.slots?.[name] === "function" ? undefined : link.slots?.[name] as ReactNode;
  for (const [name, content] of Object.entries(link.slots ?? {})) {
    if (typeof content === "function") continue;
    const frames = link.plain ??= new Map();
    if (!frames.has(name)) frames.set(name, new PlainFrame(content as ReactNode));
  }
}
function linkedPlain(link: ChildLink, name: string): PlainFrame | undefined { return link.plain?.get(name); }

/** A stable portal source outlives the own or borrowed outlet currently placing its nodes. */
function PlainHost(props: { readonly frame: PlainFrame; readonly wrap?: (content: ReactNode) => ReactNode }): ReactNode {
  if (typeof document === "undefined") return null;
  const content = markProjected(props.frame.content);
  return createPortal(props.wrap === undefined ? content : props.wrap(content), props.frame.fragment);
}
function PlainLinkHost(props: { readonly link: ChildLink }): ReactNode {
  const { link } = props;
  React.useSyncExternalStore(link.subscribe, () => link.stamp, () => link.stamp);
  return <>{[...link.plain ?? []].map(([name, frame]) => <PlainHost key={name} frame={frame} wrap={link.wrap} />)}</>;
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
/** A comment range preserves native CSS child selectors and restores its temporary host before framework deletion. */
export function PlainSlot(props: { readonly frame: PlainFrame | undefined; readonly content: ReactNode; readonly fallback: ReactNode }): ReactNode {
  const { frame, content, fallback } = props;
  const token = React.useRef({}).current;
  const site = React.useRef<PlainSite | undefined>(undefined);
  React.useSyncExternalStore(frame?.subscribe ?? noSubscribe, frame?.snapshot ?? (() => 0), frame?.snapshot ?? (() => 0));
  const ref = React.useCallback((template: HTMLTemplateElement | null): (() => void) | undefined => {
    if (template === null || frame === undefined) return undefined;
    const range = site.current ??= { start: template.ownerDocument.createComment("html-next:plain-start"), end: template.ownerDocument.createComment("html-next:plain-end") };
    return frame.attach(template, range);
  }, [frame]);
  if (frame === undefined || typeof content === "function") return renderPlainSlot(content, fallback);
  if (typeof document === "undefined") {
    frame.serverOwner ??= token;
    return frame.serverOwner === token ? renderPlainSlot(content, fallback) : fallback;
  }
  return <><template ref={ref} />{frame.current === site.current && hasSlotContent(frame.content) ? null : fallback}</>;
}
`;
