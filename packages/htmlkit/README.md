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
  layouts/
    default.html              automatic shared shell
    default.server.ts         optional shell loader
    admin.html                named alternative shell
  pages/
    index.html                /
    index.server.ts           optional home loader
    about.html                /about/
    items/
      [slug].html             /items/[slug]/
      [slug].server.ts        loader and static entries
public/                       files copied to the deployment root
htmlkit.config.ts             optional configuration
```

A page resource selects one entry component. A single definition is inferred; a file with helper
components must select its page using `<meta name="htmlkit:page" content="page-products">`.
Selection never depends on declaration order. Helpers use ordinary HTML Next component semantics.
Layouts each declare one root component and project the page through `<slot name="page"></slot>`.
Component links and controllers use existing HTML Next syntax and resolution rules. Keep non-page
resources outside `app/pages`; filenames beginning with `_` or `.` are ignored by file routing.

Page component names must be unique across the application, including both file and registered
routes. Discovery reports both conflicting files and route patterns before executing any loaders
or controllers. Use `page-` by convention, for example `page-home`, `page-products`, and
`page-product-detail`; the prefix is recommended rather than required. One page definition may
serve several registered route aliases or many parameter values without needing another name.
Renaming a page requires route rediscovery; the development server does this on file changes.

Route URLs, component names, and bundle locations are separate identities. For example,
`app/pages/shop.html` may declare `component="page-products"`; its URL is `/shop/`, and its generated
browser module has an independent build-assigned location. `ApplicationRoute.pageName` exposes the
component name separately from `pattern` and the `component` source path. The deployment manifest's
`pages` records likewise separate `pathname`, `pageName`, and `browserModule`, so bundle grouping
does not define application routes or authored component names.

Each filename contributes a URL segment; `index.html` names its directory's URL. Whole segments
such as `[slug]` become parameters. Literal segments take priority over parameters. Routes have
trailing slashes; preview redirects directory URLs that omit them. Equivalent patterns and output
collisions are errors. Optional parameters, mixed parameter segments, groups, catch-all routes,
and client routing are outside this first delivery.

The default layout is `app/layouts/default.html` when present. Page metadata chooses a named
layout or disables it with `content="none"`. Layout selection is independent of the route URL;
choosing `admin` replaces the default shell. Nested shells can compose ordinary HTML Next
components explicitly. Adding a parent page never wraps descendant routes.

```html
<meta name="htmlkit:layout" content="admin">
<meta name="description" content="Manage your products.">
<meta property="og:title" content="Product administration">
<title>Products · Admin</title>

<template component="page-products">
  <article><h1>Products</h1></article>
</template>
```

A layout uses normal component syntax:

```html
<title>Administration</title>
<meta name="description" content="Administration tools.">
<template component="admin-shell">
  <main><header>Administration</header><slot name="page"></slot></main>
</template>
```

`htmlkit:*` metadata configures the build and is removed from the generated document. Ordinary
`title`, `meta`, and metadata `link` elements contribute to the document head. No `<head>` wrapper
is needed. The regular HTML Next resource loader accepts and ignores these metadata elements;
it does not select layouts, update a host document, or evaluate their bindings. Resource-level
`style`, `script`, `base`, policy `meta` (`http-equiv`), and arbitrary body nodes are rejected.
Component styles inside a carrier and controller references retain their normal behavior.

Head values may bind to the selected component's declared props, populated by its loader, using
the existing HTML Next binding syntax:

```html
<title $value="label"></title>
<meta name="description" from:content="description">
<link rel="canonical" from:href="canonicalURL">
<template component="page-item">
  <defs>
    <prop name="label" type="string" required>Item label</prop>
    <prop name="description" type="string" required>Description</prop>
    <prop name="canonicalURL" type="string" required>Canonical URL</prop>
  </defs>
  <article><h1 $value="label"></h1></article>
</template>
```

Head bindings use the same parser, prop contracts, serialization, and renderer as body bindings.
They run during rendering against props; they do not start browser controllers, reads, or reactive
subscriptions. Layout metadata supplies defaults. A page replaces matching title, description,
meta name/property, canonical link, or alternate language/type/media defaults. The last singleton
in a layer wins. Stylesheets and alternate languages remain repeatable; social image arrays stay
ordered, and a page's image group replaces the layout's image group. A loader's `head` fields take
precedence over that layer's declarative title/description. Values are escaped when assembled.
Use public URLs (including `base` where needed) for head links; these links do not enter Vite's
component stylesheet pipeline.

Its `[slug].server.ts` can export:

```ts
import type { LoadContext, LoaderResult } from '@nextwebwg/htmlkit';

export const entries = () => [{ slug: 'one' }, { slug: 'two' }];
export function load({ params }: LoadContext): LoaderResult {
  return {
    props: {
      label: `Item ${params.slug}`, description: `Details for ${params.slug}`,
      canonicalURL: `https://example.com/items/${params.slug}/`,
    },
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
  layoutDefaults: { '/admin/': 'admin', '/account/': 'account' },
  routes: [{
    pattern: '/catalog/[id]/',
    component: 'app/catalog/item.html',
    server: 'app/catalog/item.server.ts',
    layouts: [{ component: 'app/catalog/shell.html' }],
  }],
});
```

Page layout metadata wins over the most specific `layoutDefaults` directory prefix, then the
application `layout` option (a name or `false`), then the automatic default layout. Registered
`layouts` can supply an explicit outer-to-inner chain when no named/default override is chosen.

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

Larger documentation migrations must qualify their routes, examples, visuals, and browser behavior
against reviewed references before switching deployment. This initial proof exercises the platform;
it does not replace an existing documentation site's production output.

HTMLKit is MIT-licensed and shares the monorepo release version. It is configured for public npm
publication; creating its npm name once and configuring its trusted publisher are release setup,
not development build steps.
