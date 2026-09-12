// Runnable no-build graph using the reference implementation's public browser API.
import { startBrowserComponents } from "../../dist/browser-loader.bundle.js";

await startBrowserComponents(document, {
  onError(error) {
    console.error("[html-next]", error);
  },
});
