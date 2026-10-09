---
title: Loaders and the browser
order: 2
blurb: loaders · public props · browser delivery
eyebrow: HTMLKit
---

# Loaders and the browser

`.server.ts` and `.server.js` modules run only in Node. Layout loaders run outermost first, then the
page loader. Each receives `phase: 'prerender'`, `url`, `params`, `base`, `parent`, `fetch`, and
`signal`. `parent` merges the preceding loaders' `data` objects; later keys take precedence.
Use `base` when constructing application links or public asset URLs. `url` uses the configured
canonical origin, not a preview reader's request. Query parameters and request data are unavailable
in this static adapter; accessing `context.request` throws a source diagnostic.

Each loader returns `props`, `state`, `data`, and/or `head` (`title`, `description`, `lang`). Props
and state belong to that loader's page or layout, are checked by HTML Next, and become **public
HTML**, including structured values. `data` stays in the loader chain unless a descendant puts it
into a public prop or state. Never place secrets in props or state. Inner head fields override outer
ones. Each render runs loaders again; application module globals are not isolated between renders.

Node uses HTML Next's renderer for the baseline. It executes neither browser controllers nor
declared browser reads. Per-page browser modules register parsed definitions and let HTML Next
adopt existing DOM, resume reads, and connect controllers. The platform adds no parser, scheduler,
hydration record, or lifecycle registry. Document navigation uses native links. The browser emits
`hk:ready` on `document` after initial observation is installed.

Relative declared read sources are bundled as assets beside the browser delivery. Root-relative
read URLs are prefixed with the application base; absolute HTTP(S) sources retain their origin.
Reads remain pending in Node and start through HTML Next on browser connection.

Component CSS is emitted as an external stylesheet. Vite handles controller imports, their CSS
imports, and imported assets. Files under `public` retain their names; `_htmlkit` and `404.html`
are reserved. Public assets may not be symlinks. Builds stage output beside the deployment
directory and replace it after successful rendering and bundling. An existing nonempty output
directory must contain an HTMLKit manifest before HTMLKit will replace it.

Development uses the same renderer and loaders, with Vite serving browser modules. Changes trigger
a full document reload, including loader dependencies, component HTML, and added/removed routes.
Errors appear with source information in the preview response. Native form behavior and controller
cleanup remain HTML Next's responsibility.

Controllers can be authored as `counter.ts` and referenced from HTML as `controller="./counter.js"`.
Vite resolves and transpiles the source for development and production. Run TypeScript separately
for type checking; browser URLs refer to JavaScript bundles.

Next: [Ordered routes and navigation](/htmlkit/navigation).
