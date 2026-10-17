---
title: Configuration
order: 8
blurb: htmlkit.config.ts · plugins · build hooks · build manifest · command line · using HTMLKit from code
eyebrow: HTMLKit
---

# Configuration

HTMLKit works without configuration. To change a setting, add `htmlkit.config.ts` (or `.js`) at
the project root:

```ts
// htmlkit.config.ts
import { defineConfig } from '@nextwebwg/htmlkit';

export default defineConfig({
  base: '/docs/',
  origin: 'https://example.com',
});
```

| Option | Default | Does |
| --- | --- | --- |
| `base` | `/` | Serves the site under a path, such as `/docs/`. |
| `origin` | `http://localhost` | The site's origin, used for `url` in loaders. Setting it writes [`sitemap.xml`](#search-engines). |
| `outDir` | `dist` | Where `build` writes the site. |
| `layout` | `default` when `app/layouts/default.html` exists | The layout name for every page, or `false` for none. |
| `layouts` | none | [Named layouts](#named-layouts) beside `app/layouts/`, such as `{ home: { component: 'theme/home.html' } }`. |
| `layoutDefaults` | none | Layout names by URL prefix, such as `{ '/admin/': 'admin' }`. |
| `pages` | `[{ dir: 'app/pages' }]` | Page folders and the URL prefix each serves. |
| `routes` | none | Pages at URLs of your choosing (below). |
| `redirects` | none | Old paths and where each now lives, such as `{ '/start/': '/guide/' }` ([redirects](/htmlkit/routes#redirects)). |
| `fileRoutes` | `true` | `false` turns off page folders, so only `routes` remain. |
| `css` | none | Page-wide stylesheets for rules such as `html` and `body`, for example `['@/styles/page.css']`. Components keep their own styles. |
| `plugins` | none | [Plugins](#plugins), such as a Markdown page format. |
| `prefetch` | `interaction` | What links load before a click: `interaction`, `visible`, or `none` ([details](/htmlkit/client-navigation#faster-clicks)). |
| `robots` | none | `true`, or the text of `robots.txt`, for the build to write ([search engines](#search-engines)). |
| `linkCheck` | `error` | What `build` does with a [broken internal link](#link-check): `error` fails the build, and `warn` reports it. |
| `csp` | generated | Sources to add to each page's [Content Security Policy](#content-security-policy), `reportOnly`, or `false` for none. |

A page's own `hk:layout` wins over `layoutDefaults`, which win over `layout`. Each selects the outermost
layout; a folder's `_layout.html` nests inside it ([nested layouts](/htmlkit/routes#nested-layouts)).

## `@/` and built-in components

`@/` is the project root:

```html
<link rel="component" href="@/components/card.html">
```

```ts
import { site } from '@/lib/site.ts';
```

It works in component links, controllers, stylesheet `@import`s, and loader imports. The built-in
components `<hk-nav>`, `<hk-breadcrumbs>`, and `<hk-pager>` need no link at all; the `hk-` prefix is
reserved for them.

## Routes in code

`routes` adds pages at URLs of your choosing, with the same loaders, layouts, and parameters as
page files:

```ts
export default defineConfig({
  routes: [{
    pattern: '/catalog/[id]/',
    component: 'app/catalog/item.html',
    server: 'app/catalog/item.server.ts',
    layouts: [{ component: 'app/catalog/shell.html' }],
  }],
});
```

## Page folders

`pages` can serve one folder at several URL prefixes, which is how a documentation site keeps
versions side by side. A folder can also give its pages a layout, and `optional: true` skips a folder
that doesn't exist:

```ts
export default defineConfig({
  pages: [
    { dir: 'app/pages' },
    { dir: 'docs', prefix: '/docs/', layout: 'docs' },   // app/layouts/docs.html
  ],
});
```

A page's own `hk:layout` wins over its folder's layout, which wins over `layoutDefaults` and `layout`.

A folder served at a second prefix, such as the current version of the docs at both `/` and
`/v/current/`, marks that entry `alias: true`. Its pages are served and navigable there, are left
out of [`sitemap.xml`](#search-engines), and each has a `<link rel="canonical">` to the same page
under the folder's own prefix, unless the page sets one:

```ts
export default defineConfig({
  pages: [
    { dir: 'docs' },
    { dir: 'docs', prefix: '/v/current/', alias: true },
  ],
});
```

A folder at two prefixes without `alias: true` on one of them is an error that names both, as is an
alias entry without an entry for the folder itself.

## Plugins

A plugin can add a page format and adjust options. This one makes `.note` files into pages:

```ts
import { createHash } from 'node:crypto';
import { defineConfig, type HtmlKitPlugin } from '@nextwebwg/htmlkit';

const notes: HtmlKitPlugin = {
  name: 'notes',
  pages: {
    extensions: ['.note'],
    compile(source, page) {
      // Each page needs its own valid component name; a hash of its path is both.
      const name = createHash('sha256').update(page.file).digest('hex').slice(0, 12);
      return `<template component="note-${name}"><defs><title>Note</title></defs><article>${source}</article></template>`;
    },
  },
};

export default defineConfig({ plugins: [notes] });
```

HTMLKit routes, orders, watches, renders, and builds `.note` files like `.html` pages, and errors
name the `.note` file. A compiled page is an HTML Next component, so its head content and `hk:`
settings go in its `<defs>`. While compiling, a plugin can call:

- `page.href(file)` for another page's URL;
- `page.asset(file)` to serve a file the page references, such as an image, and get its URL;
- `page.watch(file)` for a file the page's output depends on, such as a metadata file beside it.

`htmlkit dev` watches the project root, and also each file a plugin passes to `page.watch`, inside the
root or outside it. When one changes, it recompiles the pages and reloads open pages:

```ts
compile(source, page) {
  const shared = resolve(dirname(page.file), '_shared.md');
  page.watch(shared);
  return render(source + readFileSync(shared, 'utf8'));
}
```

A plugin's `config(options)` returns settings to merge before the site starts. Page folders,
stylesheets, and routes are added to the site's own, and `app/pages` stays. Give a plugin's page
folders their own `layout` (a name, or `{ component, server: { load } }` with an in-process loader)
so it doesn't wrap the site's other pages. A plugin can also set a `headScript` that runs before
`app/head.js`, and add [named layouts](#named-layouts).
[Markupress](https://github.com/threadlabs-studio/markupress) is built this way.

### Named layouts

`layouts` gives layouts names that `hk:layout`, `layout`, `layoutDefaults`, and a `pages` entry's
`layout` can use, as they use the files in `app/layouts/`. Each is a component with an optional
loader: a module path, or for a plugin, the loader itself:

```ts
const theme: HtmlKitPlugin = {
  name: 'theme',
  config: () => ({
    layouts: {
      home: { component: '/path/to/theme/home.html', server: { load: () => ({ props: { title: 'Welcome' } }) } },
    },
  }),
};
```

A page with `<meta name="hk:layout" content="home">` then renders inside it, and its loader's
`data` reaches the page's loader as `parent`. A `default` entry wraps every page as `default.html`
does. HTMLKit looks a name up in this order, and the first match is the layout:

1. The site's own `layouts` option.
2. The site's `app/layouts/<name>.html`.
3. Plugins' `layouts`, earliest plugin first.

So a site replaces a plugin's `home` layout by adding `app/layouts/home.html`.

A layout's loader receives `propNames`, the props its component declares, which are the props it may
return. A plugin that has more data than a site's layout declares returns
`Object.fromEntries(Object.entries(data).filter(([name]) => propNames.includes(name)))` and passes
the rest on as `data`.

### Build hooks

`buildStart` and `buildEnd` run steps around a build, such as generating data before it or writing a
sitemap after it:

```ts
import { defineConfig, type HtmlKitPlugin } from '@nextwebwg/htmlkit';
import { generateApi } from './scripts/generate-api.ts';

const site: HtmlKitPlugin = {
  name: 'site',
  async buildStart({ root }) {
    await generateApi(root);   // writes app/data/api.json, which loaders read
  },
  async buildEnd({ pages, writeFile }) {
    const origin = 'https://example.com';
    await writeFile('sitemap.txt', pages.map(pathname => origin + pathname).join('\n'));
  },
};

export default defineConfig({ plugins: [site] });
```

`buildStart(context)` runs before HTMLKit reads any page, so pages, data, and assets it generates
are part of the build. It runs once per `htmlkit build`, and once when `htmlkit dev` starts; editing
a file doesn't rerun it. Its context has:

| Field | Value |
| --- | --- |
| `command` | `'build'` or `'dev'` |
| `root` | The absolute project root. |
| `base` | The `base` option, such as `/docs/`. |

`buildEnd(context)` runs once the build has written every page, asset, `sitemap.xml` and `robots.txt`,
and the [manifest](#build-manifest), and before the [link check](#link-check) and the new output
replacing `outDir`. Links to the files it writes pass the link check. Its context has:

| Field | Value |
| --- | --- |
| `root`, `base` | As in `buildStart`. |
| `outDir` | The directory being built, which becomes `outDir` when every `buildEnd` succeeds. |
| `routes` | Every route, as `createApplication` lists them. |
| `pages` | Each built page's URL path, such as `/docs/guide/`. `404.html` isn't one. |
| `writeFile(path, contents)` | Writes a string or bytes at a path relative to the output. |

`writeFile` refuses a path outside the output, a path in `_htmlkit/`, and a file that already
exists, so a plugin can't replace a page, a public file, or another plugin's file.

Plugins run each hook in the order they're listed. If a hook throws, the build fails with an error
that names the plugin and the hook, and the previous `outDir` stays as it was. `htmlkit preview`
and `createApplication` don't run either hook.

## Search engines

With `origin` set, `htmlkit build` writes `sitemap.xml` at the site's base, listing each page at its
own URL:

```ts
export default defineConfig({ origin: 'https://example.com', base: '/docs/', robots: true });
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/docs/</loc></url>
<url><loc>https://example.com/docs/guide/</loc></url>
</urlset>
```

It lists every page in the [manifest](#build-manifest)'s `routes` except an
[`hk:alias`](/htmlkit/routes#the-page-head) URL or [alias page folder](#page-folders) page, whose page names its own URL as canonical, and a page
with `<meta name="robots" content="noindex">` (or `none`). Redirects and the not-found page are
outside `routes`. A page with `hk:navigation="hidden"` is listed: that setting concerns navigation,
and `noindex` takes a page out of search results. A `sitemap.xml` in `public/` is the site's own,
and the build keeps it.

`robots` writes `robots.txt`. `true` allows every crawler, and a string is the file's text. With
`origin` set, the file ends with a `Sitemap` line, unless the text has one:

```text
User-agent: *
Allow: /
Sitemap: https://example.com/docs/sitemap.xml
```

Crawlers read `robots.txt` at the origin's root, so for a site under a base path, the host places it
there. A `robots.txt` in `public/` beside the `robots` option is an error.

## Link check

`htmlkit build` reads every page it wrote, along with its redirect pages and `404.html`, and checks
each `<a href>` and `<area href>` that leads under `base`. The build fails on a link to a page or file
that isn't in the output, or to a `#fragment` that names no `id` (or `<a name>`) in its page. A
fragment-only link such as `#install` checks the page it's on. The error names each page and link:

```text
Broken internal links:
  /docs/guide/ links to /docs/missing/, which is no page or file in the build.
  /docs/guide/ links to #nowhere, and /docs/guide/ has no element with id "nowhere".
```

Links to other sites and to paths outside `base` pass as written, as do `#`, `#top`, and text
fragments (`#:~:text=`). A link without its trailing slash, such as `/docs/guide`, finds the page at
`/docs/guide/`. The check reads the built HTML, so it covers the links and ids the server rendered.
`linkCheck: 'warn'` reports the same links as a warning and finishes the build.

## Content Security Policy

Every page carries the site's Content Security Policy, which HTMLKit generates from what the site's
components declare. It allows the scripts the site needs and nothing else:

```text
script-src 'self' https://js.stripe.com 'sha256-…'; object-src 'none'; base-uri 'none'
```

- `'self'` for HTMLKit's own modules, the page's controllers, and same-origin declared scripts.
- The origin of each [declared script](/htmlkit/routes#declared-scripts) any page, layout, or
  component of the site names, such as `https://js.stripe.com` for a checkout page that declares
  Stripe.js.
- A `sha256` hash of each inline head script: a plugin's `headScript` and `app/head.js`.
- `object-src 'none'` and `base-uri 'none'`, since pages use neither plugins nor `<base>`.

The `csp` option adds sources to any directive, in CSP's own grammar. They join the generated ones
and never replace them:

```ts
// htmlkit.config.ts
export default defineConfig({
  csp: {
    'script-src': ['https://cdn.example/'],
    'connect-src': ["'self'", 'https://api.example'],
    'frame-src': ['https://js.stripe.com', 'https://hooks.stripe.com'],
  },
});
```

| Where | Delivery |
| --- | --- |
| `htmlkit build` | Each page's `<meta http-equiv="Content-Security-Policy">`, first in its head, so static hosts enforce it. A meta element ignores `frame-ancestors`, `report-uri`, and `sandbox`, so the page's meta leaves them out. |
| `htmlkit start` and `application.fetch` | The `Content-Security-Policy` header, with every directive, beside the page's meta. |
| `htmlkit dev` | The same header and meta, plus what Vite needs (below). |

`reportOnly: true` sends `Content-Security-Policy-Report-Only` instead, which reports violations and
blocks nothing. Only a header can report only, so built pages then carry no meta, and a static host
needs its own header configuration to report. `csp: false` turns the policy off.

The policy is site-wide. A document keeps the policy it loaded with, and
[client navigation](/htmlkit/client-navigation) moves between pages in place, so one policy covers
every page a visitor can reach. A policy per page would need a full page load whenever it changes.

In development, `htmlkit dev` reports each violation in the terminal and the browser console, with the
page, what was blocked, the directive, and the line that would allow it:

```text
HTMLKit: /checkout/ blocked https://m.stripe.network/inner.html under frame-src. To allow it, add to htmlkit.config.ts: csp: { "frame-src": ["https://m.stripe.network"] }
```

Vite's client and modules load from the development server, which `'self'` allows. Where the
policy restricts `connect-src` (or `default-src`), development adds `ws:` for Vite's HMR socket, and
where it restricts `style-src`, `'unsafe-inline'` for the styles Vite injects for CSS a module
imports. Builds have neither.

## Build manifest

`htmlkit build` writes `_htmlkit/manifest.json`, which lists the site's pages for tools such as a
link checker or a coverage report. Read it with `readManifest(outDir)`, which returns a typed
`BuildManifest`:

```ts
import { readManifest } from '@nextwebwg/htmlkit';

const { base, routes, pages, redirects } = await readManifest('dist');
```

```json
{
  "version": 1,
  "base": "/docs/",
  "routes": ["/docs/", "/docs/guide/"],
  "pages": [
    {
      "pathname": "/docs/",
      "pageName": "home-page",
      "browserModule": "/docs/_htmlkit/page-0-BxfIu_Pn.js",
      "chunks": ["/docs/_htmlkit/client-Cq3Rt8aZ.js"]
    }
  ],
  "redirects": [
    { "from": "/docs/start/", "to": "/docs/guide/", "status": 308 }
  ]
}
```

| Field | Value |
| --- | --- |
| `version` | The format version, `1`. |
| `base` | The `base` the site was built for. |
| `routes` | Each page's URL path, including `base`, in build order. `404.html` isn't listed. |
| `pages` | One entry per route, in the same order. |
| `pages[].pathname` | The page's URL path. |
| `pages[].pageName` | The page's component name. |
| `pages[].browserModule` | The URL of the page's own browser module. |
| `pages[].chunks` | URLs of the shared modules the page imports. |
| `redirects` | Each redirect page the build wrote, from the [`redirects` option](/htmlkit/routes#redirects) and from loaders' [`redirect()`](/htmlkit/loaders#redirecting). |
| `redirects[].from` | The old URL path, where the redirect page is. |
| `redirects[].to` | Where it sends readers: a URL path including `base`, or an absolute URL. |
| `redirects[].status` | The status a server answers with: 308 for the option, and the loader's status for `redirect()`. |

These fields are stable. A release may add fields at version `1`, so ignore fields you don't use.
`version` changes only when a field is removed, renamed, or changes meaning, and `readManifest`
refuses a version it doesn't know. File names inside `_htmlkit/` change from build to build; read
them from the manifest. The manifest lists prerendered pages; pages that
[render on each request](/htmlkit/loaders#rendering-on-each-request) have no file to list.
`_htmlkit/server/` holds the [request server](/htmlkit/deployment#the-node-server).

## Command line

```text
htmlkit <command> [root] [options]
```

| Command | Does |
| --- | --- |
| `htmlkit dev` | Serves the application with live reload, rendering every page, endpoint, and middleware on request. |
| `htmlkit build` | Prerenders pages and writes them, the browser bundles, and the request server to `dist/`. |
| `htmlkit preview` | Serves `dist/` as a static host does: files only. |
| `htmlkit start` | Serves the build on Node, without Vite: prerendered pages and assets from files, plus server-rendered pages, endpoints, and middleware ([deployment](/htmlkit/deployment#the-node-server)). |

| Option | Commands | Does |
| --- | --- | --- |
| `[root]` | all | The project folder; the current folder unless given. |
| `--base /docs/` | `dev`, `build` | Serves the site under a path. `preview` and `start` take it from the build. |
| `--origin https://example.com` | `dev`, `build` | The origin of prerendered pages' `url`. |
| `--out-dir dist` | `build`, `preview`, `start` | The build output. |
| `--port 3000` | `dev`, `preview`, `start` | The port; `start` also reads `PORT`. |
| `--host 127.0.0.1` | `dev`, `preview`, `start` | The host; `start` also reads `HOST`. |
| `--render-workers 4` | all | How many workers render pages: the number of available CPUs, up to 8, unless given. |
| `-h`, `--help` | | Lists the commands and options. |

Flags override the same settings in `htmlkit.config.ts`. `start` runs the build alone and doesn't read
the config file.

## Using HTMLKit from code

```ts
import { buildApplication, createApplication, devApplication, previewApplication } from '@nextwebwg/htmlkit';

await buildApplication({ root: 'site' });

const app = await createApplication({ root: 'site' });
const page = await app.render('/about/');       // { status, html, head, … }
const response = await app.fetch(new Request('http://localhost/about/'));
await app.close();
```

These functions take the same options as the config file, which they don't read. Close
applications and servers when you're done.

`loadConfig(root)` reads `htmlkit.config.ts` or `.js` at `root` as the CLI does, and returns its
options, or `{}` when there is no file. A command that wraps HTMLKit loads the site's config this way
and adds its own settings:

```ts
import { buildApplication, loadConfig } from '@nextwebwg/htmlkit';

const config = await loadConfig(root);
await buildApplication({ ...config, root, plugins: [...config.plugins ?? [], docs()] });
```

`app.fetch(request)` takes a standard `Request` and returns a `Response`, on Node, Deno 2.8+, and
Bun. Pass it directly, as in `Deno.serve(app.fetch)`. It answers as the development server does:
middleware, endpoints, and pages, with prerendered pages' loaders run as a build runs them. Its pages
don't include browser scripts; the development server adds those. `app.endpoints` lists the
`app/api` endpoints and `app.middleware` names the middleware file.

`startApplication({ outDir, port, host })` is `htmlkit start`. Import it from
`@nextwebwg/htmlkit/server`, which never loads Vite; see [deployment](/htmlkit/deployment#from-code).
