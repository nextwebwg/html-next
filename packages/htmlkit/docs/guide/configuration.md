---
title: Configuration
order: 4
blurb: htmlkit.config.ts · plugins · using HTMLKit from code
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
| `layoutDefaults` | none | Layout names by URL prefix, such as `{ '/admin/': 'admin' }`. |
| `pages` | `[{ dir: 'app/pages' }]` | Page folders and the URL prefix each serves. |
| `routes` | none | Pages at URLs of your choosing (below). |
| `fileRoutes` | `true` | `false` turns off page folders, so only `routes` remain. |
| `css` | none | Global stylesheets for every page, such as `['@/styles/site.css']`. |
| `plugins` | none | [Plugins](#plugins), such as a Markdown page format. |

A page's own `hk:layout` wins over `layoutDefaults`, which win over `layout`.

## `@/` and built-in components

`@/` is the project root everywhere HTMLKit resolves a path:

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
versions side by side:

```ts
export default defineConfig({
  pages: [{ dir: 'docs', prefix: '/v/current/' }, { dir: 'docs' }],
});
```

## Plugins

A plugin can add a page format and adjust options. This one makes `.note` files into pages:

```ts
import { basename } from 'node:path';
import { defineConfig, type HtmlKitPlugin } from '@nextwebwg/htmlkit';

const notes: HtmlKitPlugin = {
  name: 'notes',
  pages: {
    extensions: ['.note'],
    compile(source, page) {
      // Each page needs its own component name.
      return `<template component="note-${basename(page.file, '.note')}"><article>${source}</article></template>`;
    },
  },
};

export default defineConfig({ plugins: [notes] });
```

HTMLKit routes, orders, watches, renders, and builds `.note` files like `.html` pages, and errors
name the `.note` file. While compiling, a plugin can call:

- `page.href(file)` for another page's URL;
- `page.asset(file)` to serve a file the page references, such as an image, and get its URL.

A plugin's `config(options)` returns settings to merge before the site starts: page folders, a
layout (whose loader may be an object, `{ component, server: { load } }`), or a `headScript` that
runs before `app/head.js`. [Markupress](https://github.com/threadlabs-studio/markupress) is built
this way.

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

`app.fetch(request)` takes a standard `Request` and returns a `Response`, on Node, Deno 2.8+, and
Bun. Pass it directly, as in `Deno.serve(app.fetch)`. Its pages don't include browser scripts; the
development server adds those. Loaders still run as they do for a static build.
