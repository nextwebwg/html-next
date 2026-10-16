export { createApplication } from "./application.js";
export { buildApplication, readManifest } from "./build.js";
export { devApplication, previewApplication } from "./serve.js";
export { startApplication } from "./server.js";
export { discoverRoutes } from "./routes.js";
export { HtmlKitError, loadConfig } from "./config.js";
import type { ApplicationOptions } from "./types.js";
/** Type-check an htmlkit.config.ts file without changing its values. */
export function defineConfig(options: ApplicationOptions): ApplicationOptions { return options; }
export type { Application, ApplicationOptions, ApplicationRoute, ApplicationServer, BrowserDefinition, BuildEndContext, BuildManifest, BuildResult, BuildStartContext,
  EndpointContext, EndpointHandler, EndpointModule, EndpointRoute, HtmlKitPlugin, PageContext, PageDirectory, HeadElement, LoadContext, LoaderResult, ManifestPage,
  ManifestRedirect, Middleware, NavigationItem, NavigationNode, NavigationQuery, PagerLinks, PageHead, PrefetchPolicy, RedirectStatus, RenderedHead, RenderedLayer,
  RenderedPage, RouteGroup, RouteInput, RouteLayer, RouteParam, ServerApplication, ServerModule, ServerOptions, StartOptions } from "./types.js";
