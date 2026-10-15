---
title: Configuration
order: 5
blurb: htmlkit.config.ts · plugins · build hooks · build manifest · using HTMLKit from code
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
| `origin` | `http://localhost` | The site's origin, used for `url` in loaders. |
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
      return `<template component="note-${name}"><article>${source}</article></template>`;
    },
  },
};

export default defineConfig({ plugins: [notes] });
```

HTMLKit routes, orders, watches, renders, and builds `.note` files like `.html` pages, and errors
name the `.note` file. While compiling, a plugin can call:

- `page.href(file)` for another page's URL;
- `page.asset(file)` to serve a file the page references, such as an image, and get its URL.

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
`data` reaches the page's loader as `parent`. A `layouts` entry takes the place of
`app/layouts/<name>.html`, and a `default` entry wraps every page as `default.html` does. A plugin's
`layouts` add to the site's own; for a name defined twice, the site's own entry, then the earliest
plugin's, wins.

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

`buildEnd(context)` runs once the build has written every page, asset, and the
[manifest](#build-manifest), and before the new output replaces `outDir`. Its context has:

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
them from the manifest.

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
Bun. Pass it directly, as in `Deno.serve(app.fetch)`. Its pages don't include browser scripts; the
development server adds those. Loaders still run as they do for a static build.
