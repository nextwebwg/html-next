---
title: HTMLKit
order: -1
blurb: routes · layouts · loaders · static pages
eyebrow: HTMLKit
status: Open source · MIT licensed
pager: false
---

# Build applications with HTML Next components.

HTMLKit (`@nextwebwg/htmlkit`) turns a folder of HTML Next components into a website. It provides file routes, layouts, server loaders, browser delivery, and development tools. The first production adapter generates static pages; [the server-rendering design](https://github.com/nextwebwg/html-next/blob/main/packages/htmlkit/docs/server-rendering.md) keeps a path open to request-time rendering.

## Install and run

Use Node `>=22.22.2 <23 || >=24.15 <25`. Install `@nextwebwg/htmlkit` and add its commands to your
`package.json` scripts:

```json
{
  "scripts": {
    "dev": "htmlkit dev",
    "build": "htmlkit build",
    "preview": "htmlkit preview"
  }
}
```

Then run `pnpm dev`, `pnpm build`, or `pnpm preview` (`npm run dev` and the others work too).

Commands accept an optional application root and `--base /docs/`, `--origin https://example.com`,
`--out-dir dist`, `--port 3000`, and `--host 127.0.0.1`. Development and preview default to loopback.
Preview serves the built files without running loaders.

## Deploy

`htmlkit build` writes a static site to `dist`. Deploy that folder to a static host at the chosen
base path, and configure the host's missing-page response to use `404.html`.

## Where to go next

| You want to… | Start here |
| --- | --- |
| Lay out pages, URLs, and shared shells | [Routes and layouts](/htmlkit/routes) |
| Load data for a page and understand what reaches the browser | [Loaders and the browser](/htmlkit/loaders) |
| Order pages and build a site navigation | [Ordered routes and navigation](/htmlkit/navigation) |
| Register routes in code or use HTMLKit as a library | [Configuration and API](/htmlkit/configuration) |

HTMLKit renders [HTML Next](/html-next/) components. The component language itself is the [Declarative HTML Components](/declarative-components/) proposal.
