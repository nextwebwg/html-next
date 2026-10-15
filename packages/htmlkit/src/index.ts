export { createApplication } from "./application.js";
export { buildApplication, readManifest } from "./build.js";
export { devApplication, previewApplication } from "./serve.js";
export { discoverRoutes } from "./routes.js";
export { HtmlKitError } from "./config.js";
import type { ApplicationOptions } from "./types.js";
/** Type-check an htmlkit.config.ts file without changing its values. */
export function defineConfig(options: ApplicationOptions): ApplicationOptions { return options; }
export type { Application, ApplicationOptions, ApplicationRoute, ApplicationServer, BrowserDefinition, BuildEndContext, BuildManifest, BuildResult, BuildStartContext, HtmlKitPlugin, PageContext, PageDirectory,
  HeadElement, LoadContext, LoaderResult, ManifestPage, ManifestRedirect, NavigationItem, NavigationQuery, PagerLinks, PageHead, PrefetchPolicy, RedirectStatus, RenderedHead, RenderedLayer, RenderedPage,
  RouteGroup, RouteInput, RouteLayer, RouteParam, ServerModule, ServerOptions } from "./types.js";
