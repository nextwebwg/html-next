// Live delivery entry: no build step. The loader fetches the definition graph, lowers the
// instances already in the document, and keeps observing for later ones.
import { startBrowserComponents } from "../../dist/browser-loader.bundle.js";

await startBrowserComponents(document, {
  onError(error) {
    console.error("[html-next]", error);
  },
});
