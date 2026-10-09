import type { ComponentDefinition } from "@nextwebwg/html-next";

export interface ApplicationOptions {
  readonly root?: string;
  /** Absolute URL path prefix, for example /docs/. */
  readonly base?: string;
  /** Canonical origin used by static loaders; defaults to http://localhost. */
  readonly origin?: string;
  readonly outDir?: string;
  /** Discover app/pages by default; disable for an entirely registered route table. */
  readonly fileRoutes?: boolean;
  /** Page directories and the URL prefixes they serve; defaults to app/pages at /. A directory may serve several prefixes. */
  readonly pages?: readonly PageDirectory[];
  /** Additional routes, using the same [param] pattern syntax as discovered pages. */
  readonly routes?: readonly RouteInput[];
  /** Named layout, or a layout a plugin supplies; default.html is automatic when present. false disables it. */
  readonly layout?: string | false | RouteLayer;
  /** Route-directory defaults, overridden by page metadata; longest prefix wins. */
  readonly layoutDefaults?: Readonly<Record<string, string | false>>;
  readonly plugins?: readonly HtmlKitPlugin[];
  /** A classic script inlined with app/head.js, before it, so it runs before first paint; plugins may set it. */
  readonly headScript?: string;
  /**
   * What links prefetch before a click: "interaction" (default) fetches a page's payload and module
   * when its link is hovered, focused, or touched; "visible" also does so for links on screen; "none"
   * prefetches nothing. A link or its ancestor overrides it with data-hk-prefetch.
   */
  readonly prefetch?: PrefetchPolicy;
}

export type PrefetchPolicy = "interaction" | "visible" | "none";

export interface PageDirectory {
  /** Relative to the application root, which must contain it. */
  readonly dir: string;
  /** URL prefix with leading and trailing slashes; default /. */
  readonly prefix?: string;
}

export interface HtmlKitPlugin {
  readonly name: string;
  /** Options merged before the application starts, such as page directories or a layout. */
  readonly config?: (options: ApplicationOptions) => ApplicationOptions | void | Promise<ApplicationOptions | void>;
  /** Page files with these extensions compile to HTML Next page resources, then route like .html pages. */
  readonly pages?: {
    readonly extensions: readonly string[];
    compile(source: string, page: PageContext): string | Promise<string>;
  };
}

export interface PageContext {
  /** The page's absolute source path. Diagnostics and relative references in its resource use it. */
  readonly file: string;
  /** Deployment URL of the page compiled from another absolute source path, in the first directory that serves it. */
  href(target: string): string | undefined;
  /** Serve a file inside the application root that the page references, and return its deployment URL. */
  asset(file: string): string;
}

export interface PageHead {
  readonly title?: string;
  readonly description?: string;
  readonly lang?: string;
}

export interface RenderedHead extends PageHead {
  /** Rendered native metadata, merged by identity; values are escaped on output. */
  readonly elements?: readonly HeadElement[];
  /** A plugin's headScript, then app/head.js, each inlined after the charset so they run before first paint. */
  readonly scripts?: readonly string[];
}

export interface HeadElement {
  readonly tag: "meta" | "link";
  readonly attributes: Readonly<Record<string, string>>;
}

export interface LoaderResult {
  /** Values for this page/layout's declared props. These become public HTML. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Values for this page/layout's declared state. These become public HTML. */
  readonly state?: Readonly<Record<string, unknown>>;
  /** Server-only values merged into descendant loaders' parent data. */
  readonly data?: Readonly<Record<string, unknown>>;
  readonly head?: PageHead;
}

export interface LoadContext {
  readonly phase: "prerender";
  readonly url: URL;
  readonly base: string;
  readonly params: Readonly<Record<string, string>>;
  readonly parent: Readonly<Record<string, unknown>>;
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
  /** Ordered concrete routes. from is an application-relative directory prefix. */
  readonly navigation: (options?: NavigationQuery) => Promise<readonly NavigationItem[]>;
  /** Unavailable during static generation; accessing it throws a diagnostic. */
  readonly request: Request;
}

export interface ServerModule {
  readonly load?: (context: LoadContext) => LoaderResult | Promise<LoaderResult>;
  readonly entries?: () => readonly Readonly<Record<string, string>>[] | Promise<readonly Readonly<Record<string, string>>[]>;
}

/** server is a loader module path, or for a plugin's layout, the loader module itself. */
export interface RouteLayer { readonly component: string; readonly server?: string | ServerModule; }
export interface RouteInput extends RouteLayer {
  readonly pattern: string;
  readonly layouts?: readonly RouteLayer[];
}
export interface ApplicationRoute extends RouteLayer {
  /** The selected component tag, independent of the route pattern and source file. */
  readonly pageName: string;
  readonly pattern: string;
  readonly segments: readonly string[];
  readonly params: readonly string[];
  readonly layouts: readonly RouteLayer[];
  /** From the page's hk:label metadata; navigation otherwise labels the last URL segment. */
  readonly label?: string;
  /** hk:navigation="hidden" metadata leaves the page out of navigation. */
  readonly hidden?: boolean;
  /** For an hk:alias route, the pattern of the page's own route, which navigation marks current. */
  readonly canonical?: string;
  /** Per-segment numeric file order; independent of URLs and component identity. */
  readonly order?: readonly (string | null)[];
}
export interface NavigationQuery {
  /** Application-relative subtree, e.g. /guide/. Defaults to /. */
  readonly from?: string;
  /** Deployment pathname used for aria-current. Loaders default to their current URL. */
  readonly current?: string;
}
export interface NavigationItem {
  readonly href: string;
  readonly label: string;
  readonly current: "page" | "false";
  readonly depth: number;
  readonly pageName: string;
}
export interface BrowserDefinition {
  readonly definition: ComponentDefinition;
  readonly controller?: string;
  readonly styles: { readonly css: string; readonly stateNames: readonly string[] };
}
export interface RenderedPage {
  readonly status: 200 | 404;
  readonly pathname: string;
  readonly html: string;
  readonly css: string;
  readonly head: RenderedHead;
  readonly body: string;
  readonly components: readonly BrowserDefinition[];
  /** Each layer's invocation, outermost first, from which the browser renders the page from its payload. */
  readonly layers: readonly RenderedLayer[];
}
export interface RenderedLayer {
  readonly component: string;
  /** The invocation's prop attributes, in their HTML form, defaults included. */
  readonly attributes: Readonly<Record<string, string>>;
  /** The loader's initial state, when it returned one. */
  readonly state?: Readonly<Record<string, unknown>>;
}
export interface Application {
  readonly root: string;
  readonly base: string;
  readonly outDir: string;
  readonly routes: readonly ApplicationRoute[];
  /** Files that plugin pages reference through PageContext.asset, by deployment-relative path. */
  readonly files: ReadonlyMap<string, string>;
  /** Enumerate the exact deployment URLs, diagnosing omitted dynamic entries. */
  entries(): Promise<readonly string[]>;
  navigation(options?: NavigationQuery): Promise<readonly NavigationItem[]>;
  /** Render a fresh declarative baseline without executing browser controllers. */
  render(pathname: string, signal?: AbortSignal): Promise<RenderedPage>;
  /**
   * Serve pages for a native Request, on any runtime with fetch types: GET and HEAD under base, 308 to
   * a route's trailing-slash URL, 404, and 405. Documents include browser modules only when the
   * serving adapter supplies them, as the development server does.
   */
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export interface BuildResult { readonly outDir: string; readonly routes: readonly string[]; readonly browserInputs: readonly string[]; }
export interface ServerOptions extends ApplicationOptions { readonly host?: string; readonly port?: number; }
export interface ApplicationServer { readonly url: string; close(): Promise<void>; }
