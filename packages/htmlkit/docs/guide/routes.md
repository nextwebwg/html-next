---
title: Routes and layouts
order: 1
blurb: file routes · layouts · page head
eyebrow: HTMLKit
---

# Routes and layouts

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
components must select its page using `<meta name="hk:page" content="page-products">`.
Selection never depends on declaration order. The file-level selector is separate from component-owned
metadata: each page or layout declares its own title, description, links, and layout choice as direct
children of its `<template component>`. Helpers use ordinary HTML Next component semantics; their
metadata never contributes to the page head, even when the page renders them.
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
<template component="page-products">
  <meta name="hk:layout" content="admin">
  <meta name="description" content="Manage your products.">
  <meta property="og:title" content="Product administration">
  <title>Products · Admin</title>

  <article><h1>Products</h1></article>
</template>
```

A layout uses normal component syntax:

```html
<template component="admin-shell">
  <title>Administration</title>
  <meta name="description" content="Administration tools.">
  <main><header>Administration</header><slot name="page"></slot></main>
</template>
```

`hk:*` metadata configures the build and is removed from the generated document. Inside a
page's carrier, `hk:layout` picks its layout, `hk:label` and `hk:navigation`
(`content="hidden"`) shape [navigation](./navigation.md), and each `hk:alias` adds a further
route for the page, such as `content="/start/"`, relative to its page directory's prefix. Ordinary
`title`, `meta`, and metadata `link` elements directly inside a selected carrier contribute to the
document head. They are siblings of `<defs>`, the rendered root, and `<style>`; no `<head>` wrapper
is needed. Keep only `hk:page` and component dependency links at file scope. HTMLKit diagnoses
file-level head metadata instead of silently assigning it to a component. The regular HTML Next
resource loader accepts and ignores resource-level and direct carrier metadata;
it does not select layouts, update a host document, or evaluate their bindings. Resource-level
`style`, `script`, `base`, policy `meta` (`http-equiv`), and arbitrary body nodes are rejected.
Component styles inside a carrier and controller references retain their normal behavior.

An optional `app/head.js` is inlined as a classic script into every generated page head, after the
charset declaration and before stylesheets, so it runs before first paint. Keep it to small,
synchronous work that must precede rendering, such as applying a saved color theme; everything else
belongs in a controller. It has no bindings or imports and cannot contain `<!--`, `<script`, or
`</script`. A Content Security Policy must allow it, for example with a `'sha256-…'` hash of its
text. Component carriers still cannot contain scripts.

Head values may bind to the selected component's declared props, populated by its loader, using
the existing HTML Next binding syntax:

```html
<template component="page-item">
  <title $value="$label"></title>
  <meta name="description" from:content="$description">
  <link rel="canonical" from:href="$canonicalURL">
  <defs>
    <prop name="label" type="string" required>Item label</prop>
    <prop name="description" type="string" required>Description</prop>
    <prop name="canonicalURL" type="string" required>Canonical URL</prop>
  </defs>
  <article><h1 $value="$label"></h1></article>
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

Next: [Loaders and the browser](/htmlkit/loaders).
