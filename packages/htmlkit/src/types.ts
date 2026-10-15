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
  /**
   * Named layouts beside app/layouts, such as { home: { component, server: { load } } }. hk:layout,
   * layout, layoutDefaults, and a page directory's layout name them. A name resolves to an entry here,
   * then app/layouts/<name>.html, then a plugin's layouts entry, earliest plugin first.
   */
  readonly layouts?: Readonly<Record<string, RouteLayer>>;
  /** Route-directory defaults, overridden by page metadata; longest prefix wins. */
  readonly layoutDefaults?: Readonly<Record<string, string | false>>;
  readonly plugins?: readonly HtmlKitPlugin[];
  /**
   * Global stylesheets on every page, relative to the root or starting with @/. Unlike component
   * styles they are not scoped, so they can style built-in components such as <hk-nav>.
   */
  readonly css?: readonly string[];
  /** A classic script inlined with app/head.js, before it, so it runs before first paint; plugins may set it. */
  readonly headScript?: string;
  /**
   * What links prefetch before a click: "interaction" (default) fetches a page's payload and module
   * when its link is hovered, focused, or touched; "visible" also does so for links on screen; "none"
   * prefetches nothing. A link or its ancestor overrides it with data-hk-prefetch.
   */
  readonly prefetch?: PrefetchPolicy;
  /**
   * Old application paths and where each now lives, such as { "/start/": "/guide/intro/" }: an
   * application path or an http(s) URL. Requests answer 308; static builds write a redirect page.
   */
  readonly redirects?: Readonly<Record<string, string>>;
}

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

export type PrefetchPolicy = "interaction" | "visible" | "none";

export interface PageDirectory {
  /** Relative to the application root, which must contain it. */
  readonly dir: string;
  /** URL prefix with leading and trailing slashes; default /. */
  readonly prefix?: string;
  /** Layout for this directory's pages unless a page names its own; a plugin scopes its layout this way. */
  readonly layout?: string | false | RouteLayer;
  /** Skip the directory when it doesn't exist, as the default app/pages is. */
  readonly optional?: boolean;
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
  /**
   * A folder's label and order in navigation, such as from a metadata file inside it, for each folder
   * and (group) folder in a page directory; dir is its absolute path. For each field, the earliest
   * plugin that gives one wins.
   */
  readonly folder?: (dir: string, context: FolderContext) => FolderMetadata | void | Promise<FolderMetadata | void>;
  /** Runs before HTMLKit reads any page: once per build, and once when the development server starts. */
  readonly buildStart?: (context: BuildStartContext) => void | Promise<void>;
  /**
   * Runs after a build writes every page, asset, and the manifest to its staging directory, before the
   * output replaces outDir. A throw fails the build and leaves the previous output in place.
   */
  readonly buildEnd?: (context: BuildEndContext) => void | Promise<void>;
}

export interface FolderMetadata {
  /**
   * The folder's label in navigation trees, in place of its name, or of a group's parentheses. A
   * folder's index page labels it by its own hk:label first.
   */
  readonly label?: string;
  /**
   * Its place among its neighbours, a whole number in place of its number-and-dot prefix, for
   * navigation(), navigationTree() and pager(). hk:order on the folder's index page takes precedence.
   */
  readonly order?: number;
}

export interface FolderContext {
  /** Recompile pages in development when this file changes, such as the metadata file folder() read. */
  watch(file: string): void;
}

export interface BuildStartContext {
  readonly command: "build" | "dev";
  /** The absolute application root. */
  readonly root: string;
  readonly base: string;
}

export interface BuildEndContext {
  readonly root: string;
  readonly base: string;
  /** The staging directory, which becomes outDir once every buildEnd hook succeeds. */
  readonly outDir: string;
  readonly routes: readonly ApplicationRoute[];
  /** Each built page's deployment pathname, as in the manifest's routes; 404.html is not one. */
  readonly pages: readonly string[];
  /**
   * Write a file at a path relative to the output, such as sitemap.xml. Refuses a path outside the
   * output, in the reserved _htmlkit directory, or at a file that already exists.
   */
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
}

/** _htmlkit/manifest.json, the build's public route manifest. version changes only with an incompatible format. */
export interface BuildManifest {
  readonly version: 1;
  readonly base: string;
  /** Each page's deployment pathname, in build order. */
  readonly routes: readonly string[];
  readonly pages: readonly ManifestPage[];
  /** Each redirect page the build wrote, from the redirects option and from loaders. */
  readonly redirects: readonly ManifestRedirect[];
}

export interface ManifestRedirect {
  /** The old deployment pathname, where the build wrote the redirect page. */
  readonly from: string;
  /** The Location: a deployment pathname or an absolute URL. */
  readonly to: string;
  readonly status: RedirectStatus;
}

export interface ManifestPage {
  readonly pathname: string;
  readonly pageName: string;
  /** The page's own browser module URL. */
  readonly browserModule: string;
  /** URLs of the shared modules the page imports. */
  readonly chunks: readonly string[];
}

export interface PageContext {
  /** The page's absolute source path. Diagnostics and relative references in its resource use it. */
  readonly file: string;
  /** Deployment URL of the page compiled from another absolute source path, in the first directory that serves it. */
  href(target: string): string | undefined;
  /** Serve a file inside the application root that the page references, and return its deployment URL. */
  asset(file: string): string;
  /** Recompile pages in development when this file changes, such as one compile() read beside the page. */
  watch(file: string): void;
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
  /** Each [name] parameter's segment, and each [...name] or [[...name]] parameter's list of segments. */
  readonly params: Readonly<Record<string, RouteParam>>;
  readonly parent: Readonly<Record<string, unknown>>;
  /** The props the loader's own page or layout component declares, which are the props it may return. */
  readonly propNames: readonly string[];
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
  /** Ordered concrete routes. from is an application-relative directory prefix. */
  readonly navigation: (options?: NavigationQuery) => Promise<readonly NavigationItem[]>;
  /** The same pages as navigation(), nested by folder and (group) folder, for <hk-nav>. */
  readonly navigationTree: (options?: NavigationQuery) => Promise<readonly NavigationNode[]>;
  /** Each existing page from `from` (default /) down to the current page, for <hk-breadcrumbs>. */
  readonly breadcrumbs: (options?: NavigationQuery) => Promise<readonly NavigationItem[]>;
  /** The pages before and after the current one in navigation order, for <hk-pager>. */
  readonly pager: (options?: NavigationQuery) => Promise<PagerLinks>;
  /**
   * Stop loading and redirect to an application path or an http(s) URL, with status 303 unless
   * given: requests answer with it, and static builds write a redirect page.
   */
  readonly redirect: (location: string, status?: RedirectStatus) => never;
  /** Unavailable during static generation; accessing it throws a diagnostic. */
  readonly request: Request;
}

export interface ServerModule {
  readonly load?: (context: LoadContext) => LoaderResult | Promise<LoaderResult>;
  readonly entries?: () => readonly Readonly<Record<string, RouteParam>>[] | Promise<readonly Readonly<Record<string, RouteParam>>[]>;
}
export type RouteParam = string | readonly string[];

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
  /** The page's static <title>, which labels its folder in a navigation tree when hk:label is absent. */
  readonly title?: string;
  /** hk:navigation="hidden" metadata leaves the page out of navigation. */
  readonly hidden?: boolean;
  /** For an hk:alias route, the pattern of the page's own route, which navigation marks current. */
  readonly canonical?: string;
  /** Per-segment numeric file order; independent of URLs and component identity. */
  readonly order?: readonly (string | null)[];
  /** The (group) folders the page is in, outermost first. */
  readonly groups?: readonly RouteGroup[];
}
/** A (group) folder: it orders and labels its pages and adds no URL segment. */
export interface RouteGroup {
  /** The text inside the parentheses. */
  readonly label: string;
  /** The folder's number-and-dot order, as in order. */
  readonly order: string | null;
  /** How many URL segments, base excluded, lead to the folder. */
  readonly depth: number;
}
export interface NavigationQuery {
  /** Application-relative subtree, e.g. /guide/. Defaults to /. */
  readonly from?: string;
  /** Deployment pathname used for aria-current. Loaders default to their current URL. */
  readonly current?: string;
}
export interface PagerLinks {
  readonly previous?: NavigationItem;
  readonly next?: NavigationItem;
}
export interface NavigationItem {
  readonly href: string;
  readonly label: string;
  readonly current: "page" | "false";
  readonly depth: number;
  readonly pageName: string;
  /** The label of the innermost (group) folder the page is in; absent outside groups. */
  readonly group?: string;
}
/**
 * A navigation tree node: a page, a folder, or a (group) folder, in navigation order. A folder with
 * an index page is that page's node, with the folder's pages as children.
 */
export interface NavigationNode {
  /**
   * A page's label. A folder's is its index page's hk:label, then a plugin's folder() label, then the
   * index page's <title>, then the folder name; a group's is a plugin's folder() label, then its parentheses.
   */
  readonly label: string;
  /** The page URL, for a page or a folder with an index page. */
  readonly href?: string;
  readonly pageName?: string;
  readonly current: "page" | "false";
  /** Whether the node or one of its descendants is the current page. */
  readonly open: boolean;
  /** The nesting level, 0 at the top of the tree. */
  readonly depth: number;
  /** The number-and-dot, folder() or hk:order rank, or null when the node has none. */
  readonly order: string | null;
  readonly children: readonly NavigationNode[];
}
export interface BrowserDefinition {
  readonly definition: ComponentDefinition;
  readonly controller?: string;
  readonly styles: { readonly css: string; readonly stateNames: readonly string[] };
}
export interface RenderedPage {
  readonly status: 200 | 404 | RedirectStatus;
  readonly pathname: string;
  /** A redirect's Location; html is then its redirect page. */
  readonly location?: string;
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
  /** app/pages/404.html, which renders every unmatched path with status 404; it is not a route. */
  readonly notFound?: ApplicationRoute;
  /** Files that plugin pages reference through PageContext.asset, by deployment-relative path. */
  readonly files: ReadonlyMap<string, string>;
  /** The absolute paths plugins passed to watch(), which the development server watches. */
  readonly watchFiles: ReadonlySet<string>;
  /** Enumerate the exact deployment URLs, diagnosing omitted dynamic entries. */
  entries(): Promise<readonly string[]>;
  navigation(options?: NavigationQuery): Promise<readonly NavigationItem[]>;
  navigationTree(options?: NavigationQuery): Promise<readonly NavigationNode[]>;
  /** Render a fresh declarative baseline without executing browser controllers. */
  render(pathname: string, signal?: AbortSignal): Promise<RenderedPage>;
  /**
   * Serve pages for a native Request, on any runtime with fetch types: GET and HEAD under base, redirects, 308 to
   * a route's trailing-slash URL, 404, and 405. Documents include browser modules only when the
   * serving adapter supplies them, as the development server does.
   */
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export interface BuildResult { readonly outDir: string; readonly routes: readonly string[]; readonly browserInputs: readonly string[]; }
export interface ServerOptions extends ApplicationOptions { readonly host?: string; readonly port?: number; }
export interface ApplicationServer { readonly url: string; close(): Promise<void>; }
