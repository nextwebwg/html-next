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
| `app/pages/docs/[...path].html` | `/docs/a/` and `/docs/a/b/` (any depth) |
| `app/pages/docs/(guides)/intro.html` | `/docs/intro/` (`(guides)` organizes the files without adding a URL segment) |

A few rules cover the rest:

- `index.html` is its folder's page.
- URLs end with a slash. The development server, `preview`, and `application.fetch` redirect
  `/about` to `/about/`. A static host decides for itself, so check its trailing-slash setting.
- Files and folders starting with `_` or `.` are not pages, so keep helpers there or in `app/components`.
- Pages and page folders are regular files and folders, as `public/` files are: a symbolic link to
  one is an error that names it. To serve pages kept elsewhere, add their folder to the
  [`pages` option](/htmlkit/configuration#page-folders).
- A number and a dot at the start of a name, as in `01.guide/`, orders [navigation](/htmlkit/navigation)
  and never appears in the URL.

## A page

A page is an HTML Next component. Its `<title>` and `<meta>` tags go in its `<defs>`, and HTML Next
adds them to the document head ([The page head](#the-page-head)):

```html
<!-- app/pages/about.html -->
<template component="page-about">
  <defs>
    <title>About us</title>
    <meta name="description" content="Who we are.">
  </defs>
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

## Catch-all pages

`[...name]` matches one or more segments, and `[[...name]]` matches any number, including none. The
parameter is the list of segments:

| File | Matches | `params` |
| --- | --- | --- |
| `app/pages/docs/[...path].html` | `/docs/a/`, `/docs/a/b/` | `{ path: ['a'] }`, `{ path: ['a', 'b'] }` |
| `app/pages/files/[[...path]].html` | `/files/`, `/files/a/b/` | `{ path: [] }`, `{ path: ['a', 'b'] }` |

A catch-all is the last part of its route, so it is a file name or a folder holding only an
`index.html`. Its `entries()` list each page as a list of segments:

```ts
// app/pages/docs/[...path].server.ts
export const entries = () => [{ path: ['guide', 'intro'] }, { path: ['api'] }];

export function load({ params }) {
  return { props: { title: params.path.join(' / ') } };
}
```

When several pages could match a URL, HTMLKit compares their segments from the left. At the first
segment where they differ, a literal name wins over `[name]`, which wins over `[...name]`, which
wins over `[[...name]]`. So with `docs/index.html`, `docs/[id].html`, and `docs/[...path].html`,
`/docs/` is the index, `/docs/a/` is `[id]`, and `/docs/a/b/` is `[...path]`. A build reports an
entry whose URL a more specific page matches.

## Route groups

Wrap a folder's name in parentheses, such as `(marketing)`, to organize pages without including
that folder name in their URLs. HTMLKit calls this a **route group**:

| File | URL |
| --- | --- |
| `app/pages/marketing/about.html` | `/marketing/about/` |
| `app/pages/(marketing)/about.html` | `/about/` |
| `app/pages/docs/(guides)/intro.html` | `/docs/intro/` |

Use a route group when pages should share a layout or appear under one navigation heading
without adding the group's name to their addresses. In the last example, `docs` is still part of
the URL; only `(guides)` is left out.

The text inside the parentheses labels the group in [navigation](/htmlkit/navigation#groups).
You can add a number and a dot before the opening parenthesis to order the group among its
neighbours. For example, these pages appear under “Getting started” and “Reference” headings:

```text
app/pages/docs/
  index.html                    /docs/
  01.(Getting started)/
    _layout.html                wraps intro and setup
    01.intro.html               /docs/intro/
    02.setup.html               /docs/setup/
  02.(Reference)/
    api.html                    /docs/api/
```

A group is a folder like any other: its `_layout.html` and `_layout.server.ts` wrap its pages, and
it can hold further folders and groups. Two pages in different groups that produce the same URL
are an error that names both files.

## Layouts

A layout wraps pages. `app/layouts/default.html` wraps every page automatically; the page appears
where the layout puts `<slot name="page">`:

```html
<!-- app/layouts/default.html -->
<template component="site-shell">
  <defs><title>My site</title></defs>
  <header>My site</header>
  <main><slot name="page"></slot></main>
</template>
```

To use another layout for one page, name it; `content="none"` uses no layout:

```html
<template component="page-dashboard">
  <defs><meta name="hk:layout" content="admin"></defs>   <!-- app/layouts/admin.html -->
  <h1>Dashboard</h1>
</template>
```

A layout name is an entry of the site's `layouts` option, a file in `app/layouts/`, or a plugin's
layout, in that order ([Configuration](/htmlkit/configuration#named-layouts)). A name that matches
none of them is an error that names the page and the file it expected.

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

During client navigation, the layouts two pages share stay in place, with their state and module instances,
and take the new page's loader props. Going from `/docs/guide/intro/` to `/docs/guide/setup/` keeps
all three layouts; going to `/blog/` keeps only `default`.

## The not-found page

`app/pages/404.html` is the page for any URL that matches no page. It renders through its layout like
any other page, with status 404, in development, `preview`, `htmlkit start`, and `application.fetch`. `npm run build`
writes it to `404.html`. It is not a route: `/404/` is not one of the site's pages, and navigation
doesn't list it. Its loader receives the requested URL, except in the built `404.html`, which a static
host serves for every missing path. Without the file, HTMLKit serves a plain "Page not found" page.

The same holds for a `404` page at the top of any [page folder](/htmlkit/configuration#page-folders)
served at `/`, which renders through that folder's `layout`. A folder served at another prefix, such
as `/v/one/`, serves its `404` page at no URL, and the site's not-found page answers its missing
paths.

```html
<template component="page-not-found">
  <defs><title>Page not found</title></defs>
  <h1>This page doesn't exist</h1>
  <p><a href="/">Go to the home page</a></p>
</template>
```

## The error page

`app/error.html` is the page for a request that fails: a loader, an [endpoint](/htmlkit/server), or
middleware throws, or the page doesn't
render. It renders through its layout with status 500, and receives the `status` and `message` props
when it declares them. `message` is the status's reason phrase, `Internal Server Error`. The error
itself goes to the server's console, so its message and stack stay out of the page.

```html
<!-- app/error.html -->
<template component="page-error">
  <defs>
    <prop name="status" type="number" required>Status</prop>
    <prop name="message" type="string" required>Reason</prop>
    <title>Something went wrong</title>
  </defs>
  <main>
    <h1>{$status}: {$message}</h1>
    <p><a href="/">Go to the home page</a></p>
  </main>
</template>
```

| Where | When a page fails |
| --- | --- |
| `application.fetch` | It answers 500 with `app/error.html`. The page's payload answers 500, so client navigation loads the error page's document. |
| `htmlkit dev` | It answers 500 with the error and its stack, to fix in development. |
| `htmlkit build` | The build fails with the error, and the previous `dist/` stays. A static build has no error page, because each of its pages rendered. |
| `htmlkit preview` | It serves the built pages, which rendered during the build. |
| `htmlkit start` | It answers 500 with `app/error.html`, which the build includes in the server when pages render on request or there are endpoints or middleware. |

Like the not-found page, it is not a route: no URL serves it, and navigation doesn't list it. It
takes its layout as a page does, from `hk:layout`, the `layout` option, or `default.html`, and it
has no loader of its own. When the layout's loader is what fails, or when there is no
`app/error.html`, HTMLKit answers with a plain "Internal Server Error" page.

## Redirects

The `redirects` option sends old URLs to their new place. Each key is an application path, and each
value is an application path or an `http(s)` URL. Application paths get the site's base path:

```ts
// htmlkit.config.ts
export default defineConfig({
  redirects: {
    '/getting-started/': '/docs/intro/',
    '/chat/': 'https://example.com/community/',
  },
});
```

The development server, `htmlkit start`, and `application.fetch` answer `/getting-started/` and `/getting-started`
with a 308 and a `Location` header. A static build writes a page at each old URL, for hosts such as
GitHub Pages, which serve files as they are. The page refreshes to the new URL at once, names it as
canonical, and links to it for readers who stay on the page:

```html
<meta http-equiv="refresh" content="0; url=/docs/intro/">
<link rel="canonical" href="/docs/intro/">
…
<p>This page is now at <a href="/docs/intro/">/docs/intro/</a>.</p>
```

A redirect from a page's own URL is an error that names the page. The build lists every redirect in
the manifest's
[`redirects`](/htmlkit/configuration#build-manifest). To redirect from a loader, for example after
checking data, use [`redirect()`](/htmlkit/loaders#redirecting).

## The page head

A page or layout declares what it adds to the document head in its `<defs>`, as every HTML Next
component does with [head declarations](https://nextwebwg.org/declarative-components/components#head-declarations):
a `<title>`, `<meta>` entries, `<link>` resource hints and metadata links, JSON-LD blocks, and the
external scripts it needs. They read the component's props, state, and data:

```html
<template component="page-post">
  <defs>
    <prop name="title" type="string" required>Post title</prop>
    <prop name="summary" type="string" required>Post summary</prop>
    <prop name="schema" type="object" required>Structured data</prop>
    <title>{$title} · My blog</title>
    <meta name="description" from:content="$summary">
    <meta property="og:title" from:content="$title">
    <script type="application/ld+json" from:value="$schema"></script>
  </defs>
  <article><h1>{$title}</h1></article>
</template>
```

- **The page wins.** A `<title>`, a canonical link, and each `<meta>` name or property come from the
  deepest component that declares them, so a page's replace its layout's. Any component on the page,
  such as a product card, may declare head content too.
- **Everything else is kept.** Other links, such as a preconnect, and JSON-LD blocks stay while any
  component on the page declares them.
- **Stylesheets are styles.** A page's stylesheet is an `@import` in its `<style>`, such as
  `<style>@import "./page.css";</style>`. `<link rel="stylesheet">` is not a head declaration.
- **Head content goes in `<defs>`.** A `<title>`, `<meta>`, or `<link>` placed directly in a
  `<template component>` is an error that names the component.
- **Packages don't set the page's identity.** A component reached by a bare name, such as
  `@acme/ui/card.html` or `@/components/card.html`, is an imported component. Its page-wide entries,
  which are the canonical, `alternate`, `icon`, and `manifest` links, the `robots`, `referrer`,
  `viewport`, `color-scheme`, and `theme-color` metas, and `og:url`, are left out with an `HL011`
  warning. Pages, layouts, and components linked by a relative path set them.
- **Navigation changes the head once.** When [client navigation](/htmlkit/client-navigation)
  replaces a page, HTML Next updates the head in one step, so no layout title shows between two page
  titles.

Every document starts from `<meta charset="utf-8">` and `<meta name="viewport"
content="width=device-width, initial-scale=1">`, which a page's own viewport meta replaces. A
loader sets the document's language with `head: { lang }`; a loader's other values reach the head
as props.

### Declared scripts

A component that needs a third-party script, such as a payment form that needs Stripe.js, declares
it:

```html
<defs>
  <link rel="preconnect" href="https://js.stripe.com">
  <script name="stripe" src="https://js.stripe.com/v3/" loading="lazy"></script>
</defs>
```

HTML Next inserts one `<script>` for each URL, once per document, when a component that declares
it connects (`eager`, the default), comes near the viewport (`lazy`), or calls `load()` from its
module (`manual`). A server-rendered or prerendered page carries a `<link rel="preload">` for
each eager script, and client navigation never runs a script twice. A declared script's `src` is an
absolute URL, a root-relative path to a file in `public/`, or a bare name the application's import
map resolves. `$stripe.pending`, `$stripe.ok`, and `$stripe.error` read its status, and the
connection hook waits for `host.scripts.stripe.ready`
([declared scripts](https://nextwebwg.org/declarative-components/components#declared-scripts)).

Settings that start with `hk:` configure HTMLKit. They are `<meta>` entries in the component's
`<defs>`, and HTMLKit leaves them out of the document head:

| Metadata | Does |
| --- | --- |
| `hk:page` | Chooses the page component in a file with several components. It describes the file, so it goes outside the components. |
| `hk:layout` | Chooses a layout, or `none`. |
| `hk:label` | Sets the page's label in [navigation](/htmlkit/navigation). |
| `hk:order` | Sets the page's place in [navigation](/htmlkit/navigation#ordering-pages), in place of its file name's number. |
| `hk:navigation` | `content="hidden"` keeps the page out of navigation. |
| `hk:alias` | Adds another URL for the page, such as `content="/start/"`. Its page has a canonical link to the page's own URL, unless the page sets one, and [`sitemap.xml`](/htmlkit/configuration#search-engines) lists only the page's own URL. |
| `hk:render` | `content="server"` renders the page on each request instead of at build time ([details](/htmlkit/loaders#rendering-on-each-request)). |

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
- `app/api` holds [endpoints](/htmlkit/server#endpoints), at paths without a trailing slash, and
  `app/middleware.server.ts` is [middleware](/htmlkit/server#middleware).
- Literal URL segments take priority over parameters, and parameters over
  [catch-alls](#catch-all-pages).
- Pages, layouts, and components link other components with
  `<link rel="component" href="…">`. `@/` is the project root, so
  `href="@/app/components/card.html"` works from anywhere.
- Outside HTMLKit, the regular HTML Next loader ignores page metadata, so the same component files
  still work there.
