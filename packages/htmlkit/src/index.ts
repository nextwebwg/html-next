export { createApplication } from "./application.js";
export { buildApplication, readManifest } from "./build.js";
export { devApplication, previewApplication } from "./serve.js";
export { discoverRoutes } from "./routes.js";
export { HtmlKitError } from "./config.js";
import type { ApplicationOptions } from "./types.js";
/** Type-check an htmlkit.config.ts file without changing its values. */
export function defineConfig(options: ApplicationOptions): ApplicationOptions { return options; }
export type { Application, ApplicationOptions, ApplicationRoute, ApplicationServer, BrowserDefinition, BuildEndContext, BuildManifest, BuildResult, BuildStartContext, HtmlKitPlugin, PageContext, PageDirectory,
  HeadElement, LoadContext, LoaderResult, ManifestPage, NavigationItem, NavigationQuery, PagerLinks, PageHead, PrefetchPolicy, RenderedHead, RenderedLayer, RenderedPage, RouteInput, RouteLayer, ServerModule, ServerOptions } from "./types.js";
