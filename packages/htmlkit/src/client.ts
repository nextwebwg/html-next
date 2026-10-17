/**
 * HTMLKit's browser side, shared by every page module in a document. Each page module registers
 * its components, compiled to direct DOM code, here; the first one adopts the server-rendered page
 * and starts client navigation. A navigation loads the next page's module and payload, renders its
 * layers with their factories as the server renders them, and swaps only the layers that changed.
 * Anything the payload cannot render falls back to the page's static HTML, which the components
 * adopt in place. docs/client-navigation.md records the design.
 */
import type { adoptRenderedProps, generatedHost, replaceProjectedNode } from "@nextwebwg/html-next/generated-runtime";

/** The compiled-runtime functions navigation uses, from the one runtime instance every page module shares. */
export interface Runtime {
  readonly adoptRenderedProps: typeof adoptRenderedProps;
  readonly replaceProjectedNode: typeof replaceProjectedNode;
  readonly generatedHost: typeof generatedHost;
}
export interface ClientOptions {
  readonly base: string;
  readonly prefetch: Prefetch;
  /** The build's deployment manifest, which lists each page's shared chunks. Development has none. */
  readonly manifest?: string;
}
type Prefetch = "interaction" | "visible" | "none";
/**
 * A compiled component: its factory, which adopts a server-rendered root given as its third
 * argument, and the invocation attribute each of its props is written as.
 */
export type Component = readonly [factory: (options: object, html?: Record<string, string>, root?: Element) => Element,
  props: Readonly<Record<string, string>>];
/** The JSON that document.ts's pagePayload writes. */
interface Payload {
  readonly version: 1;
  readonly head: { readonly lang: string; readonly canonical?: string };
  readonly styles: readonly string[];
  readonly modules: readonly string[];
  readonly layers: readonly { readonly component: string; readonly attributes: Readonly<Record<string, string>>;
    readonly state?: Readonly<Record<string, unknown>> }[];
}

const components = new Map<string, Component>();
let started = false;

/**
 * Adopts the server-rendered components within `root`, outermost first: each adopts the components its
 * template invokes, and a root projected into another (a page in its layout) is adopted here.
 */
function adopt(root: ParentNode): void {
  for (const element of [...root instanceof Element ? [root] : [], ...root.querySelectorAll("[data-html-next-instance]")]) {
    if (!element.hasAttribute("data-html-next-instance")) continue;
    const component = components.get(element.getAttribute("data-component")!.split(" ")[0]!);
    if (component === undefined) element.removeAttribute("data-html-next-instance");
    else component[0]({}, undefined, element);
  }
}

/** Each page module calls this once, when it is first imported. */
export function page(runtime: Runtime, options: ClientOptions, pageComponents: Readonly<Record<string, Component>>): void {
  // A document keeps one component per tag, as HTML Next's registry does (HR001). A page that
  // redefines a tag fails here, before its DOM is inserted, and loads as a document instead.
  for (const [tag, component] of Object.entries(pageComponents)) {
    if ((components.get(tag)?.[0] ?? component[0]) !== component[0]) throw new Error(`HTMLKit: <${tag}> already has another definition in this document.`);
  }
  for (const [tag, component] of Object.entries(pageComponents)) components.set(tag, component);
  if (started) return;
  started = true;
  adopt(document);
  // ponytail: links stay document navigations without NavigateEvent.sourceElement (Chrome 135, Firefox 147,
  // Safari 26.2), which carries the per-link opt-outs; earlier Navigation API versions would skip them.
  if ("navigation" in window && "sourceElement" in NavigateEvent.prototype) navigate(runtime, options);
  document.dispatchEvent(new Event("hk:ready"));
}

const layer = (root: Document, index: number) => root.getElementById(`hk-layer-${index}`);
const fresh = (time: number) => performance.now() - time < 30_000;
const loaded = async (url: string, signal?: AbortSignal): Promise<Response> => {
  const response = await fetch(url, signal === undefined ? {} : { signal });
  if (!response.ok || response.redirected) throw new Error(`HTMLKit cannot load ${url} (${response.status}).`);
  return response;
};

/** A page to swap in: its head, and its layers' roots, outermost first. */
interface Rendered { readonly next: Document; readonly layers: readonly Element[]; readonly adopt: boolean }

/**
 * Renders a payload's layers as the server does (application.ts): the same invocations, through each
 * component's factory, each page nested in its layout's `page` slot, with each loader's state. Every
 * layer renders, kept layouts included, so a kept layout gets its new props from its rendering.
 */
async function render(runtime: Runtime, payload: Payload): Promise<Rendered> {
  if (payload.version !== 1 || payload.layers.length === 0) throw new Error("HTMLKit cannot read this page payload.");
  const next = document.implementation.createHTMLDocument("");
  const append = (parent: Element, tag: string, attributes: Readonly<Record<string, string>>) => {
    const element = parent.appendChild(next.createElement(tag));
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  if (payload.head.canonical !== undefined) append(next.head, "link", { rel: "canonical", href: payload.head.canonical });
  for (const href of payload.styles) append(next.head, "link", { rel: "stylesheet", href });
  for (const src of payload.modules) append(next.head, "script", { type: "module", src });
  next.documentElement.lang = payload.head.lang;
  // Innermost first: each layer is projected into its layout's `page` slot, as its invocation is on the server.
  const layers: Element[] = [];
  for (let index = payload.layers.length - 1; index >= 0; index -= 1) {
    const { component: tag, attributes: authored, state } = payload.layers[index]!;
    const component = components.get(tag);
    if (component === undefined) throw new Error(`HTMLKit cannot render <${tag}>: no page module defines it.`);
    const attributes: Record<string, string> = { id: `hk-layer-${index}`, ...index === 0 ? {} : { slot: "page" } };
    const html: Record<string, string> = {};
    for (const [name, value] of Object.entries(authored)) {
      const prop = component[1][name];
      if (prop === undefined) attributes[name] = value; else html[prop] = value;
    }
    const root = component[0]({ attributes, ...layers.length === 0 ? {} : { slots: { page: [layers[0]] } } }, html);
    if (state !== undefined) {
      const host = runtime.generatedHost(root);
      if (host === undefined) throw new Error(`HTMLKit cannot give layer ${index} its state.`);
      Object.assign(host.state, state);
    }
    layers.unshift(root);
  }
  // As the server does: let the state's updates render.
  await new Promise(done => setTimeout(done));
  return { next, layers, adopt: false };
}

function navigate(runtime: Runtime, { base, prefetch: policy, manifest }: ClientOptions): void {
  /** The path and query whose layers the document shows. A navigation's URL commits before its layers arrive. */
  let rendered = location.pathname + location.search;
  /**
   * The links HTMLKit's documents carry: stylesheets and an alias page's canonical link. HTML Next
   * manages head declarations, marked data-component-head; elements that scripts add are never removed.
   */
  const shell = (head: HTMLHeadElement) => [...head.querySelectorAll("link:not([data-component-head])")];
  let owned: Element[] = shell(document.head);
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
  const payloadURL = (url: URL) => `${base}_htmlkit/pages/${url.pathname.slice(base.length)}payload.json${url.search}`;

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
    return url !== null && local(url, anchor) && ["", "_self"].includes((anchor as HTMLAnchorElement).target) && url.pathname + url.search !== rendered ? url : undefined;
  };
  const prefetchPage = (url: URL) => {
    const cached = prefetched.get(url.pathname + url.search);
    if (cached !== undefined && fresh(cached.time)) return;
    const payload = payloadOf(url);
    prefetched.set(url.pathname + url.search, { time: performance.now(), payload });
    payload.then(({ modules, styles }) => {
      for (const src of modules) hint("modulepreload", src);
      for (const href of styles) hint("prefetch", href);
    }).catch(() => { prefetched.delete(url.pathname + url.search); });
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
  // At idle, or within 2 s on a busy page; a timer where requestIdleCallback is missing.
  const idle = (run: () => void) => "requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 2000 }) : setTimeout(run, 1);
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

  /** A page's document, whose server markup the components adopt. */
  const parse = async (response: Response, url: URL): Promise<Rendered> => {
    if (!response.headers.get("content-type")?.startsWith("text/html")) throw new Error(`HTMLKit cannot render ${url.href} in place.`);
    const next = new DOMParser().parseFromString(await response.text(), "text/html");
    const layers: Element[] = [];
    for (let index = 0, root = layer(next, 0); root !== null; root = layer(next, ++index)) layers.push(root);
    return { next, layers, adopt: true };
  };
  const html = async (url: URL, signal: AbortSignal) => parse(await loaded(url.pathname + url.search, signal), url);
  /** A submission's redirect, for the navigation to its URL. */
  let redirected: { readonly url: string; readonly page: Rendered | undefined } | undefined;
  /**
   * A form's POST, as the browser would send it: its action's page, or for a redirect, the page it
   * redirects to, which replaces the submission's history entry as a document's POST/redirect/GET does.
   */
  const submit = async (url: URL, form: HTMLFormElement | undefined, submitter: Element | null, body: FormData, signal: AbortSignal): Promise<Rendered> => {
    const enctype = submitter?.hasAttribute("formenctype") ? (submitter as HTMLButtonElement).formEnctype : form?.enctype;
    // An urlencoded form names each file by its name, as the browser does.
    const fields = enctype === "multipart/form-data" ? body : new URLSearchParams([...body].map(([name, value]) => [name, typeof value === "string" ? value : value.name]));
    const response = await fetch(url, { method: "POST", body: fields, signal });
    if (response.redirected) {
      // The redirect's navigation, which aborts this one, renders its page from this response, read
      // first, since the abort ends its body. A page it can't render loads as any visit does.
      redirected = { url: response.url, page: await parse(response, new URL(response.url)).catch(() => undefined) };
      void navigation.navigate(response.url, { history: "replace" });
      signal.throwIfAborted();
    }
    // A validation error renders the page with its status, such as 422, as a document shows it.
    return parse(response, url);
  };
  const payload = async (url: URL, signal: AbortSignal) => {
    const cached = prefetched.get(url.pathname + url.search);
    prefetched.delete(url.pathname + url.search);
    const data = await (cached !== undefined && fresh(cached.time) ? cached.payload : payloadOf(url, signal));
    // The page's module registers its definitions before anything renders. An absolute URL is the
    // module's identity everywhere: Vite's development server adds ?import to a path, a second URL.
    await Promise.all(data.modules.map(src => import(/* @vite-ignore */ new URL(src, location.href).href)));
    signal.throwIfAborted();
    return render(runtime, data);
  };

  const visit = async (url: URL, event: NavigateEvent, form?: HTMLFormElement): Promise<void> => {
    const { signal } = event;
    const sheets: HTMLLinkElement[] = [];
    let committed = false;
    clearTimeout(intended);
    const handed = redirected?.url === url.href ? redirected.page : undefined;
    redirected = undefined;
    try {
      // The payload carries data, not markup; a page it cannot render loads from its HTML.
      const { next, layers, adopt: hydrate } = await (handed !== undefined ? handed :
        event.formData !== null ? submit(url, form, event.sourceElement, event.formData, signal) : payload(url, signal).catch(error => {
        if (signal.aborted) throw error;
        console.warn("HTMLKit renders this page from its HTML:", error);
        return html(url, signal);
      }));
      if (layers.length === 0 || layer(document, 0) === null) throw new Error(`HTMLKit cannot render ${url.href} in place: it has no layers.`);
      // Links both documents share stay; the rest are removed or added at the swap.
      const kept = new Set<Element>();
      const added: Element[] = [];
      for (const element of shell(next.head)) {
        const same = owned.find(candidate => !kept.has(candidate) && candidate.isEqualNode(element));
        if (same === undefined) added.push(element); else kept.add(same);
      }
      // New stylesheets load before the swap, so the next page never paints unstyled. Component styles
      // are scoped, so only the next page's global rules apply to this one meanwhile.
      for (const element of added) if (element instanceof HTMLLinkElement && element.relList.contains("stylesheet")) sheets.push(element);
      const loading = sheets.map(sheet => new Promise(done => { sheet.addEventListener("load", done); sheet.addEventListener("error", done); }));
      document.head.append(...sheets);
      // The next page's components register before its DOM arrives; a conflicting one falls back below.
      // Resolved against the page's URL: the next document has no <base>, which base-uri 'none' forbids.
      const modules = [...next.head.querySelectorAll('script[type="module"][src]')].map(script => import(/* @vite-ignore */ new URL(script.getAttribute("src")!, url).href));
      await Promise.all([...loading, ...modules]);
      const commit = () => {
        signal.throwIfAborted();
        committed = true;
        for (const element of owned) if (!kept.has(element)) element.remove();
        document.head.append(...added.filter(element => !sheets.includes(element as HTMLLinkElement)));
        owned = [...kept, ...added];
        document.documentElement.lang = next.documentElement.lang;
        // Layouts persist while each depth renders the same component: they keep their DOM, state,
        // and controllers, and take the new rendering's props. The page layer is always replaced.
        let index = 0;
        while (index < layers.length - 1 && layer(document, index)?.getAttribute("data-component") === layers[index]!.getAttribute("data-component")) {
          runtime.adoptRenderedProps(layer(document, index)!, layers[index]!);
          index += 1;
        }
        // A page sits in its layout's slot; the layout projects the new page as it did the old one.
        runtime.replaceProjectedNode(layer(document, index)!, layers[index]!);
        // Server markup from the fallback is adopted in place, as the first page was.
        if (hydrate) adopt(layers[index]!);
        rendered = url.pathname + url.search;
        watch();
      };
      signal.throwIfAborted();
      // The swap disconnects the old page and connects the new one, and HTML Next reconciles the head
      // once in the microtasks after it, which a view transition's update includes.
      if (typeof document.startViewTransition !== "function" || !transitions(document.styleSheets)) commit();
      else await document.startViewTransition(commit).updateCallbackDone;
      const saved = event.navigationType === "traverse" ? positions.get(event.destination.key) : undefined;
      if (saved === undefined) event.scroll(); else scrollTo(...saved);
      // The next task, when the head holds the new page's title, announces it.
      await new Promise(done => setTimeout(done));
      announcer.textContent = document.title;
    } catch (error) {
      if (!committed) for (const sheet of sheets) sheet.remove();
      if (signal.aborted) return;
      // Anything this document cannot render in place loads as a document instead. A submission's
      // URL loads with GET, so a failed render never sends its form twice.
      console.error(error);
      location.reload();
    }
  };

  // ponytail: WebKit 26.6 sometimes restores no position for an intercepted back or forward
  // navigation, so HTMLKit records where each entry was left. Other scrolling stays native.
  const positions = new Map<string, readonly [x: number, y: number]>();
  // While a navigation renders in place: data-hk-navigating on <html>, and on a submitting form,
  // data-hk-submitting and aria-busy. Only the latest navigation clears <html>'s.
  let latest = 0;
  navigation.addEventListener("navigate", event => {
    if (navigation.currentEntry !== null) positions.set(navigation.currentEntry.key, [scrollX, scrollY]);
    const url = new URL(event.destination.url);
    const source = event.sourceElement;
    // A submission's source is its submitter, or the form itself without one.
    const form = event.formData === null ? undefined : source instanceof HTMLFormElement ? source : (source as HTMLButtonElement | null)?.form ?? undefined;
    // Reloads, downloads, fragment and history.pushState changes, and other documents stay native.
    // Modified clicks and link and form targets open other browsing contexts without this event.
    if (!event.canIntercept || event.navigationType === "reload" || event.downloadRequest !== null ||
      !local(url, form ?? source) || event.destination.sameDocument && (event.navigationType !== "traverse" || url.pathname + url.search === rendered)) return;
    // After the swap, a new entry scrolls to its fragment or the top, back and forward return to
    // where the entry was left, and focus resets as after a document load.
    event.intercept({ scroll: "manual", async handler() {
      const id = ++latest;
      document.documentElement.setAttribute("data-hk-navigating", "");
      form?.setAttribute("data-hk-submitting", "");
      form?.setAttribute("aria-busy", "true");
      try { await visit(url, event, form); }
      finally {
        form?.removeAttribute("data-hk-submitting");
        form?.removeAttribute("aria-busy");
        if (id === latest) document.documentElement.removeAttribute("data-hk-navigating");
      }
    } });
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
