export { createApplication } from "./application.js";
export { buildApplication } from "./build.js";
export { devApplication, previewApplication } from "./serve.js";
export { discoverRoutes } from "./routes.js";
export { HtmlKitError } from "./config.js";
import type { ApplicationOptions } from "./types.js";
/** Type-check an htmlkit.config.ts file without changing its values. */
export function defineConfig(options: ApplicationOptions): ApplicationOptions { return options; }
export type { Application, ApplicationOptions, ApplicationRoute, ApplicationServer, BrowserDefinition, BuildResult, GeneratedApplication,
  HeadElement, LoadContext, LoaderResult, NavigationItem, NavigationQuery, PageHead, RenderedHead, RenderedPage, RouteInput, RouteLayer, ServerModule, ServerOptions } from "./types.js";
