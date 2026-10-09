---
title: Configuration and API
order: 4
blurb: htmlkit.config.ts · explicit routes · library API
eyebrow: HTMLKit
---

# Configuration and API

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

## Serving requests

`Application.fetch(request)` serves rendered pages for a native `Request` and returns a `Response`,
so the same handler runs on Node, Deno 2.8+, and Bun: GET and HEAD under `base`, a 308 redirect to a
route's trailing-slash URL, 404 for unknown paths, and 405 for other methods. The development server
uses it for every page; CI runs it on Deno and Bun. Pass the function itself, as in
`Deno.serve(application.fetch)`. Loaders still run in the `prerender` phase, because static
generation is the only production target, and documents served this way include browser modules only
when an adapter supplies them, as the development server does.

## Page directories and plugins

`pages` lists the directories that hold file routes and the URL prefix each serves. It defaults to
`[{ dir: 'app/pages' }]`, and one directory may serve several prefixes:

```ts
export default defineConfig({
  pages: [{ dir: 'docs', prefix: '/v/current/' }, { dir: 'docs' }],
});
```

A plugin adds page formats and can contribute options. Its `config(options)` returns options to merge
before the application starts, such as page directories, a layout, or a `headScript` inlined before
`app/head.js`. A plugin's layout may be a
component path with its loader module object (`layout: { component, server: { load } }`). Its
`pages` compiler claims file extensions and turns each file into an HTML Next page resource:

```ts
const notes: HtmlKitPlugin = {
  name: 'notes',
  pages: { extensions: ['.note'], compile(source, page) {
    // page.file is the source path; page.href(path) gives another page's URL;
    // page.asset(path) serves a referenced file and returns its URL.
    return `<template component="page-note">${source}</template>`;
  } },
};
```

HTMLKit then treats those files like `.html` pages: it routes, orders, and watches them, gives them
loaders, layouts, head metadata, and navigation, and renders and builds them. The page's source path
is its component identity, so diagnostics and relative references name the original file.
`page.href` returns a page's URL in the first directory that serves it. `page.asset` accepts files
inside the application root and serves them under `/_htmlkit/files/`, in development and in builds.
