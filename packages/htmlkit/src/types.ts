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
  /** Additional routes, using the same [param] pattern syntax as discovered pages. */
  readonly routes?: readonly RouteInput[];
}

export interface PageHead {
  readonly title?: string;
  readonly description?: string;
  readonly lang?: string;
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
  /** Unavailable during static generation; accessing it throws a diagnostic. */
  readonly request: Request;
}

export interface ServerModule {
  readonly load?: (context: LoadContext) => LoaderResult | Promise<LoaderResult>;
  readonly entries?: () => readonly Readonly<Record<string, string>>[] | Promise<readonly Readonly<Record<string, string>>[]>;
}

export interface RouteLayer { readonly component: string; readonly server?: string; }
export interface RouteInput extends RouteLayer {
  readonly pattern: string;
  readonly layouts?: readonly RouteLayer[];
}
export interface ApplicationRoute extends RouteLayer {
  readonly pattern: string;
  readonly segments: readonly string[];
  readonly params: readonly string[];
  readonly layouts: readonly RouteLayer[];
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
  readonly head: PageHead;
  readonly body: string;
  readonly components: readonly BrowserDefinition[];
}
export interface Application {
  readonly root: string;
  readonly base: string;
  readonly outDir: string;
  readonly routes: readonly ApplicationRoute[];
  /** Enumerate the exact deployment URLs, diagnosing omitted dynamic entries. */
  entries(): Promise<readonly string[]>;
  /** Render a fresh declarative baseline without executing browser controllers. */
  render(pathname: string, signal?: AbortSignal): Promise<RenderedPage>;
  close(): Promise<void>;
}
export interface BuildResult { readonly outDir: string; readonly routes: readonly string[]; readonly browserInputs: readonly string[]; }
export interface ServerOptions extends ApplicationOptions { readonly host?: string; readonly port?: number; }
export interface ApplicationServer { readonly url: string; close(): Promise<void>; }
