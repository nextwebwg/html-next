---
title: HTMLKit
order: -1
blurb: pages · layouts · data · static sites
eyebrow: HTMLKit
status: Open source · MIT licensed
pager: false
---

# Build websites from HTML components.

HTMLKit turns a folder of [HTML Next](/html-next/) components into a website. Each file in
`app/pages` is a page, layouts wrap pages, and small server files load their data. `htmlkit build`
writes a static site you can host anywhere.

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
    "preview": "htmlkit preview"
  }
}
```

Create your first page:

```html
<!-- app/pages/index.html -->
<template component="page-home">
  <title>Hello</title>
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
  components/     your own components
  head.js         optional script that runs before the page first paints
public/           files copied as-is, such as favicon.ico
htmlkit.config.ts optional settings
```

## Deploy

`npm run build` writes the site to `dist/`. Upload that folder to any static host, and set the
host's "page not found" response to `404.html`. `npm run preview` serves `dist/` locally first.

The commands take an optional project folder (`htmlkit dev site`), `--base /docs/` to serve the site
under a path, `--origin` for absolute URLs, `--out-dir`, `--port`, and `--host`. The servers listen on
127.0.0.1 unless you pass `--host`. `preview` serves the built files as they are; it doesn't run
loaders.

## Next steps

| To… | Read |
| --- | --- |
| Add pages, dynamic URLs, and layouts | [Pages and routing](/htmlkit/routes) |
| Load data into a page | [Loading data](/htmlkit/loaders) |
| Add site navigation and order pages | [Navigation](/htmlkit/navigation) |
| Move between pages without reloading | [Moving between pages](/htmlkit/client-navigation) |
| Change settings, use plugins, or call HTMLKit from code | [Configuration](/htmlkit/configuration) |
