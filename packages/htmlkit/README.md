# HTMLKit

HTMLKit (`@nextwebwg/htmlkit`) builds applications with HTML Next components. It provides routes,
layouts, server loaders, browser delivery, and development tools. The first production adapter
generates static pages; [the server-rendering design](./docs/server-rendering.md) preserves a path
to request-time rendering.

Use Node 22.13+ or Node 24 and Corepack pnpm. Install `@nextwebwg/htmlkit`, then run:

```sh
corepack pnpm exec htmlkit dev
corepack pnpm exec htmlkit build
corepack pnpm exec htmlkit preview
```

Commands accept an optional application root and `--base /docs/`, `--origin https://example.com`,
`--out-dir dist`, `--port 3000`, and `--host 127.0.0.1`. Development and preview default to loopback.
Preview serves the built files without running loaders. Deploy `dist` to a static host at the chosen
base path; configure its missing-page response to use `404.html`.

## Routes and layouts

File routes follow familiar Nuxt directory and parameter names:

```text
app/
  components/                 reusable HTML Next components
  pages/
    _layout.html              shell for all descendant pages
    _layout.server.ts         optional shell loader
    index.html                /
    index.server.ts           optional home loader
    about.html                /about/
    items/
      _layout.html            nested shell for /items/**
      [slug].html             /items/[slug]/
      [slug].server.ts        loader and static entries
public/                       files copied to the deployment root
htmlkit.config.ts             optional configuration
```

Pages and layouts each declare exactly one root HTML Next component. Layouts project their child
through `<slot name="page"></slot>`. Component links and controllers use the existing HTML Next
syntax and resolution rules. Keep non-page HTML components outside `app/pages`; names beginning
with `_` or `.` are ignored by file routing.

Each filename contributes a URL segment; `index.html` names its directory's URL. Whole segments
such as `[slug]` become parameters. Literal segments take priority over parameters. Routes have
trailing slashes; preview redirects directory URLs that omit them. Equivalent patterns and output
collisions are errors. Optional parameters, mixed parameter segments, groups, catch-all routes,
client routing, and named layout selection are outside this first delivery.

Directory `_layout.html` is an explicit composition boundary: a parent page does not automatically
wrap its children. This differs from Nuxt's parent page outlets and keeps page URLs independent of
their shell. Layouts use standard HTML Next slots rather than a new component declaration.

```html
<template component="item-page">
  <defs><prop name="label" type="string" required>Item label</prop></defs>
  <article><h1 $value="label"></h1></article>
</template>
```

Its `[slug].server.ts` can export:

```ts
import type { LoadContext, LoaderResult } from '@nextwebwg/htmlkit';

export const entries = () => [{ slug: 'one' }, { slug: 'two' }];
export function load({ params }: LoadContext): LoaderResult {
  return {
    props: { label: `Item ${params.slug}` },
    head: { title: `Item ${params.slug}` },
  };
}
```

Development can render any matching parameter value. Static production requires `entries()` to
list every intended parameterized page, including parameters from ancestor directories. It must
return a nonempty array with exactly the declared parameter keys. Values must be single URL
segments. Discovery and enumeration produce a complete build manifest; no link crawler decides
which pages exist.

## Loaders and browser behavior

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
`htmlkit:ready` on `document` after initial observation is installed.

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

## Explicit routes and library API

Use `htmlkit.config.ts` (or `.js`) for configuration. Explicit routes supplement file routes, or
set `fileRoutes: false` for a fully registered route table:

```ts
import { defineConfig } from '@nextwebwg/htmlkit';

export default defineConfig({
  base: '/docs/',
  routes: [{
    pattern: '/catalog/[id]/',
    component: 'app/catalog/item.html',
    server: 'app/catalog/item.server.ts',
    layouts: [{ component: 'app/catalog/shell.html' }],
  }],
});
```

Paths are relative to the application root. Explicit routes use the same parameter, loader,
composition, collision, and entry rules as file routes; they do not create another renderer.
No config file is read implicitly by the library API: pass options directly to `createApplication`,
`buildApplication`, `devApplication`, or `previewApplication`. Close returned applications and
servers when finished. `Application.render(pathname, signal?)` returns a baseline document, body,
styles, metadata, and the parsed component graph; browser delivery is added by dev/build.

## Proof applications

From this monorepo, after building packages:

```sh
corepack pnpm --filter @nextwebwg/htmlkit exec htmlkit build examples/basic
corepack pnpm --filter @nextwebwg/htmlkit exec htmlkit preview examples/basic
corepack pnpm --filter @nextwebwg/htmlkit build:docs-proof
corepack pnpm --filter @nextwebwg/htmlkit exec htmlkit preview ../../.context/htmlkit-docs-proof
```

The basic application exercises routes, loaders, state, and controllers without documentation
features. The docs proof converts this repository's Markdown guides and generates a component
reference, code display, heading anchors, search navigation, a theme, and an interactive example.
Its Markdown dependency and theme live in the consumer, outside the platform runtime and published
package. Its input is trusted, checked-in author content; it does not sanitize arbitrary Markdown.

The Looma corpus is the next qualification workload. Its existing deployment and reviewed parity
references remain the authority for that migration. This initial proof does not claim Looma parity
or replace Looma's deployed documentation.

HTMLKit is MIT-licensed and shares the monorepo release version. It is configured for public npm
publication; creating its npm name once and configuring its trusted publisher are release setup,
not development build steps.
