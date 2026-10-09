/**
 * HTMLKit's browser side, shared by every page module in a document. Each page module registers
 * its components here; the first one starts HTML Next's document observation and client
 * navigation. A navigation fetches the next page's static HTML, the same document a reader
 * without JavaScript receives, and swaps only the layers that changed. docs/client-navigation.md
 * records the native audit and the alternatives.
 */
import type { ComponentDefinition } from "@nextwebwg/html-next";
import type { adoptRenderedProps, ComponentHost, getComponentHost, observeDocument, registerComponentDefinitions } from "@nextwebwg/html-next/runtime";

export interface Runtime {
  readonly registerComponentDefinitions: typeof registerComponentDefinitions;
  readonly observeDocument: typeof observeDocument;
  readonly getComponentHost: typeof getComponentHost;
  readonly adoptRenderedProps: typeof adoptRenderedProps;
}
type Controller = { readonly default: (host: ComponentHost) => void | (() => void) };

const controllers: Record<string, Controller> = {};
const styleStates: Record<string, readonly string[]> = {};
let started = false;

/** Each page module calls this once, when it is first imported. */
export function page(runtime: Runtime, base: string, definitions: readonly ComponentDefinition[],
  pageControllers: Readonly<Record<string, Controller>>, pageStyleStates: Readonly<Record<string, readonly string[]>>): void {
  // A document keeps one definition and controller per tag (HTML Next's HR001). A page that
  // redefines a tag fails here, before its DOM is inserted, and loads as a document instead.
  for (const [tag, controller] of Object.entries(pageControllers)) {
    if ((controllers[tag] ?? controller) !== controller) throw new Error(`HTMLKit: <${tag}> already has another controller in this document.`);
  }
  Object.assign(styleStates, pageStyleStates);
  runtime.registerComponentDefinitions(definitions, document, (_css, definition) => ({ css: "", stateNames: styleStates[definition.contract.tag] ?? [] }));
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
  if ("navigation" in window) navigate(runtime, base);
  document.dispatchEvent(new Event("hk:ready"));
}

const layer = (root: Document, index: number) => root.getElementById(`hk-layer-${index}`);
const fresh = (time: number) => performance.now() - time < 30_000;

function navigate(runtime: Runtime, base: string): void {
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

  const prefetched = new Map<string, { readonly time: number; readonly html: Promise<string> }>();
  const fetchPage = async (url: string, signal?: AbortSignal): Promise<string> => {
    const response = await fetch(url, signal === undefined ? {} : { signal });
    if (!response.ok || response.redirected || !response.headers.get("content-type")?.startsWith("text/html")) {
      throw new Error(`HTMLKit cannot render ${url} in place (${response.status}).`);
    }
    return response.text();
  };
  const prefetch = (anchor: HTMLAnchorElement) => {
    const url = new URL(anchor.href);
    url.hash = "";
    const cached = prefetched.get(url.href);
    if (!local(url, anchor) || anchor.target !== "" && anchor.target !== "_self" ||
      url.pathname === rendered || cached !== undefined && fresh(cached.time)) return;
    const html = fetchPage(url.href);
    prefetched.set(url.href, { time: performance.now(), html });
    // Fetch the page's modules and stylesheets without running or applying them.
    html.then(text => {
      for (const element of new DOMParser().parseFromString(text, "text/html").head.querySelectorAll('script[type="module"][src], link[rel~="stylesheet"]')) {
        const href = element.getAttribute("src") ?? element.getAttribute("href")!;
        if (document.querySelector(`[src="${CSS.escape(href)}"], [href="${CSS.escape(href)}"]`) !== null) continue;
        const hint = document.createElement("link");
        hint.rel = element.localName === "script" ? "modulepreload" : "prefetch";
        hint.href = href;
        document.head.append(hint);
      }
    }).catch(() => { prefetched.delete(url.href); });
  };
  // Intent, not visibility: a link that keeps the pointer or focus briefly, so sweeping across a
  // menu or tabbing through it fetches nothing.
  let intended: ReturnType<typeof setTimeout> | undefined;
  const intent = (event: Event) => {
    clearTimeout(intended);
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (link instanceof HTMLAnchorElement) intended = setTimeout(prefetch, 80, link);
  };
  document.addEventListener("pointerover", intent);
  document.addEventListener("focusin", intent);

  const visit = async (url: URL, event: NavigateEvent): Promise<void> => {
    const { signal } = event;
    const sheets: HTMLLinkElement[] = [];
    let committed = false;
    clearTimeout(intended);
    try {
      const key = url.href.split("#")[0]!;
      const cached = prefetched.get(key);
      prefetched.delete(key);
      const html = await (cached !== undefined && fresh(cached.time) ? cached.html : fetchPage(key, signal));
      const next = new DOMParser().parseFromString(html, "text/html");
      if (layer(next, 0) === null || layer(document, 0) === null) throw new Error(`HTMLKit cannot render ${key} in place: it has no layers.`);
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
      const loaded = sheets.map(sheet => new Promise(done => { sheet.addEventListener("load", done); sheet.addEventListener("error", done); }));
      document.head.append(...sheets);
      // The next page's components register before its DOM arrives; a conflicting one falls back below.
      const modules = [...next.head.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map(script => import(/* @vite-ignore */ script.src));
      await Promise.all([...loaded, ...modules]);
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
        layer(document, index)!.replaceWith(incoming);
        rendered = url.pathname;
        announcer.textContent = document.title;
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
