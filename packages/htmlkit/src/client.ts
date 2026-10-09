/**
 * HTMLKit's browser side, shared by every page module in a document. Each page module registers
 * its components here; the first one starts HTML Next's document observation and client
 * navigation. A navigation loads the next page's module and payload, renders its layers with HTML
 * Next as the server does, and swaps only the layers that changed. Anything the payload cannot
 * render falls back to the page's static HTML. docs/client-navigation.md records the design.
 */
import type { ComponentDefinition } from "@nextwebwg/html-next";
import type { adoptRenderedProps, ComponentHost, getComponentHost, lowerDocument, observeDocument, registerComponentDefinitions,
  replaceProjectedNode, serializeRenderedForm } from "@nextwebwg/html-next/runtime";

export interface Runtime {
  readonly registerComponentDefinitions: typeof registerComponentDefinitions;
  readonly observeDocument: typeof observeDocument;
  readonly getComponentHost: typeof getComponentHost;
  readonly adoptRenderedProps: typeof adoptRenderedProps;
  readonly lowerDocument: typeof lowerDocument;
  readonly serializeRenderedForm: typeof serializeRenderedForm;
  readonly replaceProjectedNode: typeof replaceProjectedNode;
}
export interface ClientOptions {
  readonly base: string;
  readonly prefetch: Prefetch;
  /** The build's deployment manifest, which lists each page's shared chunks. Development has none. */
  readonly manifest?: string;
}
type Prefetch = "interaction" | "visible" | "none";
type Controller = { readonly default: (host: ComponentHost) => void | (() => void) };
/** The JSON that document.ts's pagePayload writes. */
interface Payload {
  readonly version: 1;
  readonly head: { readonly lang: string; readonly title: string; readonly description?: string;
    readonly elements: readonly { readonly tag: string; readonly attributes: Readonly<Record<string, string>> }[] };
  readonly styles: readonly string[];
  readonly modules: readonly string[];
  readonly layers: readonly { readonly component: string; readonly attributes: Readonly<Record<string, string>>;
    readonly state?: Readonly<Record<string, unknown>> }[];
}

const definitions = new Map<string, ComponentDefinition>();
const controllers: Record<string, Controller> = {};
const styleStates: Record<string, readonly string[]> = {};
const compiledStyles = (_css: string, definition: ComponentDefinition) => ({ css: "", stateNames: styleStates[definition.contract.tag] ?? [] });
let started = false;

/** Each page module calls this once, when it is first imported. */
export function page(runtime: Runtime, options: ClientOptions, pageDefinitions: readonly ComponentDefinition[],
  pageControllers: Readonly<Record<string, Controller>>, pageStyleStates: Readonly<Record<string, readonly string[]>>): void {
  // A document keeps one definition and controller per tag (HTML Next's HR001). A page that
  // redefines a tag fails here, before its DOM is inserted, and loads as a document instead.
  for (const [tag, controller] of Object.entries(pageControllers)) {
    if ((controllers[tag] ?? controller) !== controller) throw new Error(`HTMLKit: <${tag}> already has another controller in this document.`);
  }
  Object.assign(styleStates, pageStyleStates);
  runtime.registerComponentDefinitions(pageDefinitions, document, compiledStyles);
  for (const definition of pageDefinitions) definitions.set(definition.contract.tag, definition);
  Object.assign(controllers, pageControllers);
  if (started) return;
  started = true;
  const initialized = new WeakSet<ComponentHost>();
  runtime.observeDocument(document, { onConnect(element, definition) {
    const controller = controllers[definition.contract.tag];
    if (!controller) return;
    if (typeof controller.default !== "function") throw new Error(`Controller for ${definition.contract.tag} must export a default function`);
    const host = runtime.getComponentHost(element)!;
    if (initialized.has(host)) return;
    initialized.add(host);
    return controller.default(host);
  } });
  // ponytail: without the Navigation API (before Firefox 147 and Safari 26.2), links stay document navigations.
  if ("navigation" in window) navigate(runtime, options);
  document.dispatchEvent(new Event("hk:ready"));
}

const layer = (root: Document, index: number) => root.getElementById(`hk-layer-${index}`);
const fresh = (time: number) => performance.now() - time < 30_000;
const loaded = async (url: string, signal?: AbortSignal): Promise<Response> => {
  const response = await fetch(url, signal === undefined ? {} : { signal });
  if (!response.ok || response.redirected) throw new Error(`HTMLKit cannot load ${url} (${response.status}).`);
  return response;
};

/**
 * Renders a payload's layers as the server does (application.ts and HTML Next's server worker):
 * the same invocations, lowered without connecting, with each loader's state, then serialized. The
 * live document adopts the result as it adopts server HTML. Every layer renders, kept layouts
 * included, so a page reads its layouts' context and kept layouts get their new props.
 */
async function render(runtime: Runtime, payload: Payload, url: URL): Promise<Document> {
  if (payload.version !== 1 || payload.layers.length === 0) throw new Error("HTMLKit cannot read this page payload.");
  const next = document.implementation.createHTMLDocument("");
  const append = (parent: Element, tag: string, attributes: Readonly<Record<string, string>>) => {
    const element = parent.appendChild(next.createElement(tag));
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  append(next.head, "base", { href: url.href });
  for (const element of payload.head.elements) append(next.head, element.tag, element.attributes);
  if (payload.head.description !== undefined) append(next.head, "meta", { name: "description", content: payload.head.description });
  for (const href of payload.styles) append(next.head, "link", { rel: "stylesheet", href });
  for (const src of payload.modules) append(next.head, "script", { type: "module", src });
  runtime.registerComponentDefinitions([...definitions.values()], next, compiledStyles);
  let parent = next.body;
  payload.layers.forEach((layer, index) => {
    parent = append(parent, layer.component, { id: `hk-layer-${index}`, ...index === 0 ? {} : { slot: "page" }, ...layer.attributes });
  });
  runtime.lowerDocument(next, { connect: false });
  payload.layers.forEach(({ state }, index) => {
    if (state === undefined) return;
    const root = layer(next, index);
    const host = root === null ? undefined : runtime.getComponentHost(root);
    if (host === undefined) throw new Error(`HTMLKit cannot give layer ${index} its state.`);
    Object.assign(host.state, state);
  });
  // As the server does: let structural updates settle, then lower what they added.
  await new Promise(done => setTimeout(done));
  runtime.lowerDocument(next, { connect: false });
  next.body.innerHTML = runtime.serializeRenderedForm(next.body);
  next.title = payload.head.title;
  next.documentElement.lang = payload.head.lang;
  return next;
}

function navigate(runtime: Runtime, { base, prefetch: policy, manifest }: ClientOptions): void {
  /** The pathname whose layers the document shows. A navigation's URL commits before its layers arrive. */
  let rendered = location.pathname;
  /** Head metadata from server documents. Elements that scripts add are never removed. */
  let owned: Element[] = [...document.head.querySelectorAll("meta, link")];
  const announcer = document.createElement("div");
  announcer.id = "hk-announcer";
  announcer.setAttribute("aria-live", "polite");
  announcer.setAttribute("aria-atomic", "true");
  announcer.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
  document.body.append(announcer);

  /**
   * Same-origin page URLs under base. Page URLs end in a slash; files and other sites load natively.
   * Firefox 155 follows a download link's navigate event with a second one that has no downloadRequest.
   */
  const local = (url: URL, source: Element | null) => url.origin === location.origin && url.pathname.startsWith(base) &&
    url.pathname.endsWith("/") && !source?.closest("[data-hk-reload]") && !source?.hasAttribute("download");
  const payloadURL = (url: URL) => `${base}_htmlkit/pages/${url.pathname.slice(base.length)}payload.json`;

  // Prefetching never runs anything: payloads are data, and modules and stylesheets are only hinted.
  const hinted = new Set<string>();
  const hint = (rel: string, href: string) => {
    if (hinted.has(href) || document.querySelector(`[src="${CSS.escape(href)}"], [href="${CSS.escape(href)}"]`) !== null) return;
    hinted.add(href);
    const link = document.createElement("link");
    link.rel = rel;
    link.href = href;
    document.head.append(link);
  };
  const prefetched = new Map<string, { readonly time: number; readonly payload: Promise<Payload> }>();
  const payloadOf = (url: URL, signal?: AbortSignal) => loaded(payloadURL(url), signal).then(response => response.json() as Promise<Payload>);
  /** The page an HTML link would visit in place, if any. An unparsable href is not a page. */
  const target = (anchor: Element) => {
    const url = anchor instanceof HTMLAnchorElement ? URL.parse(anchor.href) : null;
    return url !== null && local(url, anchor) && ["", "_self"].includes((anchor as HTMLAnchorElement).target) && url.pathname !== rendered ? url : undefined;
  };
  const prefetchPage = (url: URL) => {
    const cached = prefetched.get(url.pathname);
    if (cached !== undefined && fresh(cached.time)) return;
    const payload = payloadOf(url);
    prefetched.set(url.pathname, { time: performance.now(), payload });
    payload.then(({ modules, styles }) => {
      for (const src of modules) hint("modulepreload", src);
      for (const href of styles) hint("prefetch", href);
    }).catch(() => { prefetched.delete(url.pathname); });
  };
  // Links on screen prefetch only the shared chunks their page needs: a page's own module holds its
  // content, so a long menu would otherwise download every page.
  let chunks: Promise<ReadonlyMap<string, readonly string[]>> | undefined;
  const prefetchShared = (url: URL) => {
    if (manifest === undefined) return;
    chunks ??= loaded(manifest).then(response => response.json())
      .then((data: { pages: { pathname: string; chunks?: string[] }[] }) => new Map(data.pages.map(page => [page.pathname, page.chunks ?? []])))
      .catch(() => new Map());
    void chunks.then(map => { for (const src of map.get(url.pathname) ?? []) hint("modulepreload", src); });
  };
  /** A link's policy: its own or an ancestor's data-hk-prefetch, else the site's. */
  const mode = (anchor: Element): Prefetch => {
    const value = anchor.closest("[data-hk-prefetch]")?.getAttribute("data-hk-prefetch");
    return value === "interaction" || value === "visible" || value === "none" ? value : policy;
  };
  // Intent: touch at once; a link that keeps the pointer or focus briefly, so sweeping across a menu
  // or tabbing through it fetches nothing.
  let intended: ReturnType<typeof setTimeout> | undefined;
  const intent = (event: Event) => {
    clearTimeout(intended);
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const url = anchor !== null && mode(anchor) !== "none" ? target(anchor) : undefined;
    if (url !== undefined) intended = setTimeout(prefetchPage, event.type === "touchstart" ? 0 : 80, url);
  };
  document.addEventListener("pointerover", intent);
  document.addEventListener("focusin", intent);
  document.addEventListener("touchstart", intent, { passive: true });
  const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1));
  const visible = new IntersectionObserver(entries => {
    for (const { isIntersecting, target: anchor } of entries) {
      if (!isIntersecting) continue;
      visible.unobserve(anchor);
      const url = target(anchor);
      const policy = mode(anchor);
      if (url !== undefined && policy !== "none") idle(() => (policy === "visible" ? prefetchPage : prefetchShared)(url));
    }
  });
  // ponytail: links that controllers add later are not watched; they still prefetch on interaction.
  const watch = () => { for (const anchor of document.querySelectorAll("a[href]")) visible.observe(anchor); };
  watch();

  const html = async (url: URL, signal: AbortSignal) => {
    const response = await loaded(url.pathname + url.search, signal);
    if (!response.headers.get("content-type")?.startsWith("text/html")) throw new Error(`HTMLKit cannot render ${url.href} in place.`);
    return new DOMParser().parseFromString(await response.text(), "text/html");
  };
  const payload = async (url: URL, signal: AbortSignal) => {
    const cached = prefetched.get(url.pathname);
    prefetched.delete(url.pathname);
    const data = await (cached !== undefined && fresh(cached.time) ? cached.payload : payloadOf(url, signal));
    // The page's module registers its definitions before anything renders. An absolute URL is the
    // module's identity everywhere: Vite's development server adds ?import to a path, a second URL.
    await Promise.all(data.modules.map(src => import(/* @vite-ignore */ new URL(src, location.href).href)));
    signal.throwIfAborted();
    return render(runtime, data, url);
  };

  const visit = async (url: URL, event: NavigateEvent): Promise<void> => {
    const { signal } = event;
    const sheets: HTMLLinkElement[] = [];
    let committed = false;
    clearTimeout(intended);
    try {
      // The payload carries data, not markup; a page it cannot render loads from its HTML.
      const next = await payload(url, signal).catch(error => {
        if (signal.aborted) throw error;
        console.warn("HTMLKit renders this page from its HTML:", error);
        return html(url, signal);
      });
      if (layer(next, 0) === null || layer(document, 0) === null) throw new Error(`HTMLKit cannot render ${url.href} in place: it has no layers.`);
      // Head metadata both documents share stays; the rest is removed or added at the swap.
      const kept = new Set<Element>();
      const added: Element[] = [];
      for (const element of next.head.querySelectorAll("meta, link")) {
        const same = owned.find(candidate => !kept.has(candidate) && candidate.isEqualNode(element));
        if (same === undefined) added.push(element); else kept.add(same);
      }
      // New stylesheets load before the swap, so the next page never paints unstyled. Component styles
      // are scoped, so only the next page's global rules apply to this one meanwhile.
      for (const element of added) if (element instanceof HTMLLinkElement && element.relList.contains("stylesheet")) sheets.push(element);
      const loading = sheets.map(sheet => new Promise(done => { sheet.addEventListener("load", done); sheet.addEventListener("error", done); }));
      document.head.append(...sheets);
      // The next page's components register before its DOM arrives; a conflicting one falls back below.
      const modules = [...next.head.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map(script => import(/* @vite-ignore */ script.src));
      await Promise.all([...loading, ...modules]);
      const commit = () => {
        signal.throwIfAborted();
        committed = true;
        for (const element of owned) if (!kept.has(element)) element.remove();
        document.head.append(...added.filter(element => !sheets.includes(element as HTMLLinkElement)));
        owned = [...kept, ...added];
        document.title = next.title;
        document.documentElement.lang = next.documentElement.lang;
        // Layouts persist while each depth renders the same component: they keep their DOM, state,
        // and controllers, and take the new rendering's props. The page layer is always replaced.
        let index = 0;
        let incoming = layer(next, 0)!;
        let deeper = layer(next, 1);
        while (deeper !== null && layer(document, index)?.getAttribute("data-component") === incoming.getAttribute("data-component")) {
          runtime.adoptRenderedProps(layer(document, index)!, incoming);
          incoming = deeper;
          deeper = layer(next, ++index + 1);
        }
        // A page sits in its layout's slot; the layout projects the new page as it did the old one.
        runtime.replaceProjectedNode(layer(document, index)!, incoming);
        rendered = url.pathname;
        announcer.textContent = document.title;
        watch();
      };
      signal.throwIfAborted();
      if (typeof document.startViewTransition !== "function" || !transitions(document.styleSheets)) commit();
      else await document.startViewTransition(commit).updateCallbackDone;
      const saved = event.navigationType === "traverse" ? positions.get(event.destination.key) : undefined;
      if (saved === undefined) event.scroll(); else scrollTo(...saved);
    } catch (error) {
      if (!committed) for (const sheet of sheets) sheet.remove();
      if (signal.aborted) return;
      // Anything this document cannot render in place loads as a document instead.
      console.error(error);
      location.reload();
    }
  };

  // ponytail: WebKit 26.6 sometimes restores no position for an intercepted back or forward
  // navigation, so HTMLKit records where each entry was left. Other scrolling stays native.
  const positions = new Map<string, readonly [x: number, y: number]>();
  navigation.addEventListener("navigate", event => {
    if (navigation.currentEntry !== null) positions.set(navigation.currentEntry.key, [scrollX, scrollY]);
    const url = new URL(event.destination.url);
    // Reloads, downloads, form posts, fragment and history.pushState changes, and other documents
    // stay native. Modified clicks and link targets open other browsing contexts without this event.
    if (!event.canIntercept || event.navigationType === "reload" || event.downloadRequest !== null || event.formData !== null ||
      !local(url, event.sourceElement) || event.destination.sameDocument && (event.navigationType !== "traverse" || url.pathname === rendered)) return;
    // After the swap, a new entry scrolls to its fragment or the top, back and forward return to
    // where the entry was left, and focus resets as after a document load.
    event.intercept({ scroll: "manual", handler: () => visit(url, event) });
  });
}

/** Authors animate navigation with @view-transition { navigation: auto }, as for document navigation. */
function transitions(rules: CSSRuleList | StyleSheetList): boolean {
  return Array.prototype.some.call(rules, (rule: CSSRule | CSSStyleSheet) => {
    try {
      return rule instanceof CSSStyleSheet ? transitions(rule.cssRules) :
        typeof CSSViewTransitionRule === "function" && rule instanceof CSSViewTransitionRule ? rule.navigation === "auto" :
          rule instanceof CSSGroupingRule && (!(rule instanceof CSSMediaRule) || matchMedia(rule.conditionText).matches) && transitions(rule.cssRules);
    } catch { return false; } // A cross-origin stylesheet hides its rules.
  });
}
