---
title: Pages and routing
order: 1
blurb: file routes · dynamic pages · layouts · page head
eyebrow: HTMLKit
---

# Pages and routing

Every file in `app/pages` is a page, and its path is its URL:

| File | URL |
| --- | --- |
| `app/pages/index.html` | `/` |
| `app/pages/about.html` | `/about/` |
| `app/pages/blog/index.html` | `/blog/` |
| `app/pages/blog/first-post.html` | `/blog/first-post/` |
| `app/pages/blog/[slug].html` | `/blog/anything/` (one page per value) |

A few rules cover the rest:

- `index.html` is its folder's page.
- URLs end with a slash. The development server, `preview`, and `application.fetch` redirect
  `/about` to `/about/`. A static host decides for itself, so check its trailing-slash setting.
- Files and folders starting with `_` or `.` are not pages, so keep helpers there or in `app/components`.
- A number and a dot at the start of a name, as in `01.guide/`, orders [navigation](/htmlkit/navigation)
  and never appears in the URL.

## A page

A page is an HTML Next component. Its `<title>` and `<meta>` tags go in the page's `<head>`:

```html
<!-- app/pages/about.html -->
<template component="page-about">
  <title>About us</title>
  <meta name="description" content="Who we are.">
  <main>
    <h1>About us</h1>
  </main>
</template>
```

Component names must be unique across the site. A `page-` prefix keeps them apart from your other
components.

If a file declares more than one component, say which one is the page:

```html
<meta name="hk:page" content="page-about">
<template component="team-card">…</template>
<template component="page-about">…</template>
```

## Dynamic pages

A name in brackets matches any single URL segment. Its value reaches the page through a
[loader](/htmlkit/loaders), which also lists the pages to build:

```text
app/pages/blog/[slug].html        /blog/first-post/, /blog/second-post/, …
app/pages/blog/[slug].server.ts   loads each post and lists the slugs
```

```ts
// app/pages/blog/[slug].server.ts
export const entries = () => [{ slug: 'first-post' }, { slug: 'second-post' }];

export function load({ params }) {
  return { props: { title: `Post ${params.slug}` } };
}
```

When a literal page and a dynamic one could both match, the literal page wins.

## Layouts

A layout wraps pages. `app/layouts/default.html` wraps every page automatically; the page appears
where the layout puts `<slot name="page">`:

```html
<!-- app/layouts/default.html -->
<template component="site-shell">
  <title>My site</title>
  <header>My site</header>
  <main><slot name="page"></slot></main>
</template>
```

To use another layout for one page, name it; `content="none"` uses no layout:

```html
<template component="page-dashboard">
  <meta name="hk:layout" content="admin">   <!-- app/layouts/admin.html -->
  <h1>Dashboard</h1>
</template>
```

To give a whole folder a layout, add a `_layout.html` to it ([below](#nested-layouts)), or see
`layoutDefaults` in [Configuration](/htmlkit/configuration).

## Nested layouts

A `_layout.html` in a folder of `app/pages` wraps every page in that folder and in the folders below it.
Each folder's layout sits inside its parent folder's layout, and the site's layout is outermost:

```text
app/layouts/default.html          site-shell
app/pages/docs/_layout.html       docs-shell, inside site-shell
app/pages/docs/guide/_layout.html guide-shell, inside docs-shell
app/pages/docs/guide/intro.html   /docs/guide/intro/, inside guide-shell
```

A folder layout is a layout like any other: one component with a `<slot name="page">`. The `_` keeps
it from being a page, so `/docs/_layout/` is not a URL. A `_layout.server.ts` beside it is its
[loader](/htmlkit/loaders#layout-loaders). Loaders run from the outside in, so `intro.html`'s loader
receives the `data` of `default`, `docs`, and `guide` as `parent`.

The layout a page selects only replaces the outermost one, and folder layouts always nest inside it:

| The page's layout | Layers for `/docs/guide/intro/` |
| --- | --- |
| None selected, with `app/layouts/default.html` | `default` → `docs` → `guide` → page |
| None selected, without `default.html` | `docs` → `guide` → page |
| `hk:layout="admin"`, or `admin` from a `pages` entry's `layout`, `layoutDefaults`, or the `layout` option | `admin` → `docs` → `guide` → page |
| `none` or `false`, from any of these | page alone |

The outermost layout is chosen in this order: `hk:layout`, then the `pages` entry's `layout`, then
`layoutDefaults`, then the `layout` option, then `app/layouts/default.html`. Pages added through the
`routes` option are outside the page tree, so they take only their own `layouts`.

During client navigation, the layouts two pages share stay in place, with their state and controllers,
and take the new page's loader props. Going from `/docs/guide/intro/` to `/docs/guide/setup/` keeps
all three layouts; going to `/blog/` keeps only `default`.

## The not-found page

`app/pages/404.html` is the page for any URL that matches no page. It renders through its layout like
any other page, with status 404, in development, `preview`, and `application.fetch`. `npm run build`
writes it to `404.html`. It is not a route: `/404/` is not one of the site's pages, and navigation
doesn't list it. Its loader receives the requested URL, except in the built `404.html`, which a static
host serves for every missing path. Without the file, HTMLKit serves a plain "Page not found" page.

```html
<template component="page-not-found">
  <title>Page not found</title>
  <h1>This page doesn't exist</h1>
  <p><a href="/">Go to the home page</a></p>
</template>
```

## The page head

`<title>`, `<meta>`, and `<link>` tags directly inside a page or layout component go in the document
head. A page's tag replaces a layout's tag with the same identity: the `<title>`, a `<meta>` with the
same `name` or `property`, the canonical `<link>`, and an alternate `<link>` with the same `hreflang`.
A page's `og:image` tags replace the layout's as a set. Every other `<link>`, such as a stylesheet, is
kept from both. Only `<title>`, `<meta>`, and `<link>` may go in the head. They can use the page's props:

```html
<template component="page-post">
  <title>{$title}</title>
  <meta name="description" from:content="$summary">
  <defs>
    <prop name="title" type="string" required>Post title</prop>
    <prop name="summary" type="string" required>Post summary</prop>
  </defs>
  <article><h1>{$title}</h1></article>
</template>
```

A loader can also set `head: { title, description, lang }`.

Settings that start with `hk:` configure HTMLKit and never reach the page:

| Metadata | Does |
| --- | --- |
| `hk:page` | Chooses the page component in a file with several components. Goes outside the components. |
| `hk:layout` | Chooses a layout, or `none`. |
| `hk:label` | Sets the page's label in [navigation](/htmlkit/navigation). |
| `hk:navigation` | `content="hidden"` keeps the page out of navigation. |
| `hk:alias` | Adds another URL for the page, such as `content="/start/"`. |

## A script before first paint

`app/head.js` runs in every page's head before anything is drawn, which is how a site applies a
saved dark theme without a flash. Keep it small, because it delays the first paint:

```js
// app/head.js
document.documentElement.dataset.theme = localStorage.getItem('theme') ?? 'light';
```

It cannot contain `<!--`, `<script`, or `</script`. If the site has a Content Security Policy,
allow it with a `'sha256-…'` hash of its text.

## Details

- Two files that produce the same URL are an error that names both files.
- Literal URL segments take priority over parameters. Optional and catch-all parameters are not
  supported yet.
- Pages, layouts, and components link other components with
  `<link rel="component" href="…">`. `@/` is the project root, so
  `href="@/app/components/card.html"` works from anywhere.
- Outside HTMLKit, the regular HTML Next loader ignores page metadata, so the same component files
  still work there.
