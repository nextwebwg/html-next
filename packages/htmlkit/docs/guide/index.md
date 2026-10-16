---
title: HTMLKit
order: -1
blurb: pages · layouts · data · static sites and servers
eyebrow: HTMLKit
status: Open source · MIT licensed
pager: false
---

# Build websites from HTML components.

HTMLKit turns a folder of [HTML Next](/html-next/) components into a website. Each file in
`app/pages` is a page, layouts wrap pages, and small server files load their data. Pages render at
build time or on each request, and `app/api` files answer requests with JSON or anything else.
`htmlkit build` writes a static site you can host anywhere, and a server that `htmlkit start` runs.

## Get started

Use Node 22 (22.22.2 or later) or Node 24 (24.15 or later). Install HTMLKit and add its commands to `package.json`:

```sh
npm install @nextwebwg/htmlkit
```

```json
{
  "type": "module",
  "scripts": {
    "dev": "htmlkit dev",
    "build": "htmlkit build",
    "preview": "htmlkit preview",
    "start": "htmlkit start"
  }
}
```

Create your first page:

```html
<!-- app/pages/index.html -->
<template component="page-home">
  <defs><title>Hello</title></defs>
  <main>
    <h1>Hello, HTMLKit</h1>
  </main>
</template>
```

Run `npm run dev` and open the URL it prints. Edit the page and the browser reloads.

## A project at a glance

```text
app/
  pages/          one file per page; the folder structure is the URL structure
  layouts/        shared shells, such as default.html
  api/            endpoints, such as todos.server.ts at /api/todos
  middleware.server.ts  optional code that runs before every page and endpoint
  components/     your own components (a convention; link them with href="@/app/components/…")
  head.js         optional script that runs before the page first paints
public/           files copied as-is, such as favicon.ico
htmlkit.config.ts optional settings
```

## Deploy

`npm run build` writes the site to `dist/`. When every page is prerendered, upload that folder to any
static host, and set the host's "page not found" response to `404.html` (your
[not-found page](/htmlkit/routes#the-not-found-page), when `app/pages/404.html` exists).
`npm run preview` serves `dist/` locally first. A site with pages that render on each request,
endpoints, or middleware runs `npm start` on Node, or the same server on Deno or Bun; see
[deployment](/htmlkit/deployment). The build checks each link to the site's own pages and fails on
one that leads to a missing page or anchor ([link check](/htmlkit/configuration#link-check)). With an
`origin`, it also writes [`sitemap.xml`](/htmlkit/configuration#search-engines).

The commands take an optional project folder (`htmlkit dev site`), `--base /docs/` to serve the site
under a path, `--origin` for absolute URLs, `--out-dir`, `--port`, and `--host`. Flags override the
same settings in `htmlkit.config.ts`. The servers listen on 127.0.0.1, port 3000, unless you pass
`--host` or `--port`. `preview` and `start` take the base path from the build, so build with the
`--base` you deploy under. The [command line reference](/htmlkit/configuration#command-line) lists
every command and option.

## Next steps

| To… | Read |
| --- | --- |
| Add pages, dynamic URLs, and layouts | [Pages and routing](/htmlkit/routes) |
| Load data into a page, at build time or on each request | [Loading data](/htmlkit/loaders) |
| Answer API requests, or run code before every request | [Endpoints and middleware](/htmlkit/server) |
| Put the site online | [Deployment](/htmlkit/deployment) |
| Add site navigation and order pages | [Navigation](/htmlkit/navigation) |
| Move between pages without reloading | [Moving between pages](/htmlkit/client-navigation) |
| Change settings, use plugins, or call HTMLKit from code | [Configuration](/htmlkit/configuration) |
