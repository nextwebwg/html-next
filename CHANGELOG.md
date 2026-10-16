# Changelog

## 1.0.0-alpha.54

### Added

- HTMLKit renders `app/error.html` when a page's loader throws or its rendering fails. `application.fetch` answers 500 with the error page through its layout, with its `status` and `message` props set when it declares them: `500` and the reason phrase `Internal Server Error`. The error itself goes to `console.error`. A failed page's payload answers 500, so client navigation loads the error page's document. When the layout's own loader fails, or without `app/error.html`, a plain "Internal Server Error" page answers. `htmlkit dev` answers 500 with the error and its stack, and `htmlkit build` fails with the error. The error page is not a route; `Application.error` names it, and `app/error.server.ts` is an error, since the page takes its props from the failure.
- With `origin` set, `htmlkit build` writes `sitemap.xml` at the base, listing each page in the manifest's `routes` except `hk:alias` URLs and pages with `<meta name="robots" content="noindex">` or `none`. Pages with `hk:navigation="hidden"` are listed. A `sitemap.xml` in `public/` is kept as the site's own. An alias page has a `<link rel="canonical">` to its page's own URL, absolute with `origin` set, unless the page sets one.
- The `robots` option writes `robots.txt`: `true` allows every crawler, and a string is the file's text. With `origin` set, the file ends with a `Sitemap` line for `sitemap.xml`, unless the text has one. A `public/robots.txt` beside the option is an error.
- `htmlkit build` checks the links in the pages, redirect pages and `404.html` it wrote, after `buildEnd`. A link under `base` to a page or file missing from the output, or to a `#fragment` naming no `id` or `<a name>` in its page, fails the build with each source page and link. Fragment-only links check their own page. `linkCheck: "warn"` reports the same links as a warning and finishes the build.
- HTMLKit request server. `htmlkit build` writes `_htmlkit/server/entry.js` to the output, and `htmlkit start` serves the build on Node without loading Vite: prerendered pages, the not-found page and assets from the output's files, with `Cache-Control: public, max-age=31536000, immutable` on hashed bundles, plus server-rendered pages, endpoints and middleware. It listens on `--host` and `--port`, or `HOST` and `PORT`, defaulting to 127.0.0.1:3000, takes the base path from the build, and never serves `_htmlkit/server/`. The redirects option's paths and loaders' redirects of prerendered pages answer with the HTTP redirect. `startApplication({ outDir, host, port })` from the new `@nextwebwg/htmlkit/server` export, which never loads Vite, does the same from code, and the CLI's `--help` lists every command and option.
- The server entry's default export is the application, whose `fetch(request)` answers a standard `Request` with a `Response`, so Deno and Bun run the same entry: `deno serve dist/_htmlkit/server/entry.js`, `bun dist/_htmlkit/server/entry.js`, or `Deno.serve(application.fetch)`. CI builds an application on Node and runs its entry on Node, Deno and Bun from packed packages, and the package test runs `htmlkit start` with a resolve hook that fails if anything loads Vite. The `ServerApplication` and `StartOptions` types describe them.
- A page's `<meta name="hk:render" content="server">` renders it on each request instead of at build time; `prerender` is the default. A build leaves server-rendered pages out of its files and manifest and bundles their browser code per route, `entries()` lists only prerendered pages, and a server-rendered dynamic page renders any URL its pattern matches without `entries()`. `ApplicationRoute.render` is `"server"` for such a page. The not-found page is always prerendered.
- Request-aware loaders. A server-rendered page's loaders receive `phase: "request"`, `url` with the request's query, `request`, `cookies` (the Cookie header's values by name) and `response`, whose `status` and `headers` every loader of the page shares, so a loader sets a header or a cookie with `response.headers.append("set-cookie", …)`. `notFound()` answers with the not-found page and status 404, in prerendering too, where a build leaves that entry out, and a redirect or `notFound()` keeps the headers set before it. Reading `request`, `cookies` or `response` while prerendering is an error that names the loader and `hk:render`.
- Endpoints. Each `app/api/**/*.server.ts` (or `.js`) file answers the matching path without a trailing slash, such as `app/api/todos/[id].server.ts` at `/api/todos/42` and `feed.xml.server.ts` at `/api/feed.xml`, with `[name]` and catch-all parameters. It exports `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, each `(request, { params })` returning a `Response`. `HEAD` answers with `GET`'s headers unless the file exports it, a method the file doesn't export answers 405 with `Allow`, and two files at one path are an error. `Application.endpoints` lists them, and the `EndpointHandler`, `EndpointContext`, `EndpointModule` and `EndpointRoute` types describe them.
- Middleware. `app/middleware.server.ts` (or `.js`) exports a default `(request, next)` that runs before every page, page payload and endpoint, and before missing paths. It returns a `Response`: its own, such as `Response.redirect(…)` or a 401, before any loader runs, or `next()`'s, whose headers and cookies it may set. `next(path or URL)` answers as that path would, a rewrite, and `next(request)` answers a changed request, such as one with a header for loaders to read. For a page's payload it sees the page's own URL. Files are served without it. `Application.middleware` names the file, and the `Middleware` type describes it.
- A failing endpoint or middleware answers with `app/error.html` as a failing page does, in `application.fetch` and under `htmlkit start`. When pages render on request, or there are endpoints or middleware, the build includes the error page in its server, which renders it through its layouts for a failed request; a static build has no error page. A link to a server-rendered page or an endpoint passes the build's link check.
- `setRenderWorkers(count)` and `closeRenderWorkers()` from `@nextwebwg/html-next/server` set the size of `renderComponents`' worker pool and end its workers. HTMLKit takes the size as `--render-workers` on every command and `renderWorkers` in `startApplication`, and `@nextwebwg/htmlkit/server` re-exports `setRenderWorkers` for Deno and Bun entries.
- `pnpm --filter @nextwebwg/htmlkit measure:server` builds a small site and reports `htmlkit start`'s throughput and latency for a prerendered page, a server-rendered page and an endpoint.
- The HTMLKit guide has "Endpoints and middleware" and "Deployment" pages: static hosts, prerendered and server pages, the Node server and its container recipe, Deno and Bun. "Loading data" documents the request API, and "Configuration" has a command-line reference.
- Head declarations, as the [proposal's head declarations section](https://nextwebwg.org/declarative-components/components#head-declarations) defines them: a definition declares `<title>`, `<meta name>` or `<meta property>`, `<link>` with a resource-hint, metadata or annotation `rel`, and `<script type="application/ld+json">` in `<defs>`, and the live runtime adds them to `document.head` while an instance is connected and removes them when it disconnects. A title takes inline text expressions, a `<meta>` binds `from:content`, a `<link>` binds `from:href`, and a JSON-LD block is literal JSON, copied unchanged, or binds its whole value with `from:value`, written as JSON with every `<` as `<` and left out for `null`. Every managed element carries `data-component-head`. A title, a canonical link and each meta name or property go to the deepest connected component, then the latest at one depth; a component's repeated metas are one list, and a sub-property such as `og:image:width` stays with its own component's `og:image`. Other links and JSON-LD blocks share one element per key while any contributor is connected. The document's own elements are set aside unchanged while a component replaces them, and put back as the same nodes. A mutation batch, such as a router replacing a page, reconciles the head once, so no intermediate title appears; inside a view transition it reconciles in the transition's update. The definition carries `head`, and its declared scripts are its `scripts` and its contract's `scripts`. A test holds the behavior in Chromium, Firefox and WebKit, with and without an application-components list.
- Document-authority entries: canonical, `alternate`, `icon` and `manifest` links, the `robots`, `referrer`, `viewport`, `color-scheme`, `theme-color` and `application-components` metas, and `og:url`, apply only from an application component. A component reached through a bare specifier, from an unlisted source, or from another imported component is imported: its graph node has `imported: true`, and its definition leaves those entries out with an `HL011` warning. The document's first `<meta name="application-components">` lists, as a CSP source list with `'self'` always included, the other sources whose components are the application's own, and the live loader accepts a cross-origin component root it lists, with that source's URL prefix as its approved root. A second list warns `HL012`, and a component's own is ignored with `HC028`.
- A definition rejects `<meta http-equiv>`, `<meta charset>`, `<base>`, `<link rel="stylesheet">`, `<link rel="import">`, other `rel` keywords, inline executable scripts, import maps and other script types, `async` and `defer` on a declared script, the `blocking` and `nonce` attributes, event-handler attributes, and attributes HTML does not define for the element, with `HC025`. A JSON-LD block that is not valid JSON, or has both literal content and `from:value`, is `HC026`, and two titles, two canonical links or two links with one `rel` and `href` are `HC027`.
- Declared scripts, as the [proposal's declared scripts section](https://nextwebwg.org/declarative-components/components#declared-scripts) defines them: `<script name src loading>` in `<defs>` makes the live runtime insert one ordinary `<script>` into `document.head` for each resolved URL and type, marked `data-component-head` and never removed. `loading="eager"`, the default, inserts it when an instance connects, `lazy` when the instance's root comes within 1,250 px of the viewport, and `manual` when the controller calls `load()`. `type="module"`, `integrity`, `crossorigin`, `referrerpolicy` and `fetchpriority` are copied onto it, and the nonce of the `<link rel="component">` or inline `<template component>` that imported the definition goes on it. A URL-like `src` resolves against the definition and a bare one through the document's import map. An authored `<script>` with the same URL and type is used instead of inserting another. `$name.pending`, `.ok` and `.error` read the script's status, and `host.scripts.name` adds `ready`, which settles once with the script, and `load()`. `on:load` and `on:error` run their handler once per connection after the script settles, never while disconnected. A declaration that disagrees with the first on `integrity`, `crossorigin` or `referrerpolicy` fails for its instance with a `TypeError` and `HR011`, and an unmapped bare `src` with `HR012`.
- `renderComponents` takes the application document's own head as `head` and returns `head`: those elements with the rendered components' head declarations reconciled into them, each family of set-aside elements in a `<template data-component-head="set-aside">` after its marked elements, and a `<link rel="preload" as="script">`, or `modulepreload` for a module, for each eager declared script no authored script provides. It writes nothing for `lazy` and `manual` scripts and no executing `<script>`. Hydration adopts the marked elements, holds the set-aside ones to restore as the same nodes, keeps the preload links, and inserts each eager script once. A test holds the scripts and hydration in Chromium, Firefox and WebKit, counting each script's runs.
- The usage guide has an "Add to the document head" section.

### Changed

- A component resource's top level holds component carriers, component links, and build metadata: a `<meta name content>` whose name has a colon, such as `app:page`. Any other `<title>`, `<meta>` or `<link>` there is `HT009`; a component's head content is its head declarations.
- Vanilla, Vue, React and Svelte output of a definition with head declarations reports `HT030`; such a component runs in the live runtime.

- `renderComponents` renders in a pool of long-lived workers, one per available CPU up to 8, each rendering one request at a time and the rest queued. Each render has its own JSDOM window and document, which the worker closes after it, its own component registry and instances, browser globals pointed at its window and restored afterwards, and its own structured-clone copies of the definitions and state; a worker keeps only its loaded modules and their static tables. A worker that fails or exits rejects the render it was doing and the next render starts a new one, and an idle worker doesn't keep the process alive. A render in a warm worker takes milliseconds; starting a worker and importing jsdom, 0.4 to 0.9 s, happens once per worker. The request-isolation test renders conflicting definitions of one tag and conflicting state concurrently and in sequence, on one worker and on three.
- HTMLKit renders each page in one `renderComponents` call: the layers, then each layer's head bindings as a component of its own with that layer's props. The page's markup is exactly as it renders alone. With the pool, a server-rendered page with a layout answers about 1,000 requests a second at a 14 ms median (6 a second at 2.5 s with a worker per call), on the same loaded machine, and building HTMLKit's examples and docs proof takes 3.2 s instead of 25.3 s, with the same pages and payloads.
- `application.fetch` and the development server pass the whole request: its method, headers, query and body. A page path without its trailing slash redirects with its query kept, as in `/items/one?x` to `/items/one/?x`, before any loader runs.
- Client navigation fetches a page's payload with the link's query, as `payload.json?page=2`, and treats a change of query as a change of page.
- `RenderedPage.status` is a `number`, since a server-rendered page's loaders set it.
- `htmlkit preview` never serves `_htmlkit/server/`.

### Fixed

- A symbolic link in an HTMLKit page folder that would be a page, such as `docs/page.md` linking to `../other/page.md`, or a page folder, is an error that names it, as a symbolic link in `public/` is. Links whose names start with `_` or `.`, and links to files that aren't pages, stay as they are. To serve pages kept elsewhere, add their folder to the `pages` option.
- The HTMLKit documentation proof links the guide's index page at `/guide/` and gives a heading with a trailing `{#name}` that id, as the guide's site does.
- An `hk:alias` of a dynamic page marks its page's own URL, with the alias's parameters, current in navigation.
- Templates keep whitespace-only text as authored, as the [proposal's whitespace section](https://nextwebwg.org/declarative-components/templating#whitespace-mixed-content) defines: `<strong>Package:</strong> <code>x</code>` and `<em>a</em>` on one line with `<em>b</em>` on the next render with their spaces in live loading, SSR and hydration, HTMLKit pages and compiled output. Before, the template parser dropped every whitespace-only text node outside `<pre>`, so they rendered as `Package:x` and `ab`. CSS collapses the kept text as it does in a hand-written page, and `white-space: pre` keeps it. Text that only a comment separates is one text node, as it renders. The parser drops whitespace-only text only where a browser never renders it: among the children of `<table>`, `<thead>`, `<tbody>`, `<tfoot>`, `<tr>` and `<colgroup>`, among SVG container children such as `<defs>` and `<g>`, between a `$match`'s arms, and beside a `$value`, `$html` or `.textContent` binding, which replaces the element's children. A slot whose fallback is only whitespace renders that whitespace when nothing is projected, and generated docs list it as optional. Compiled output grows with the whitespace it keeps; the keyed benchmark entry by 47 B gzip.
- Converted Vue, React and Svelte components keep a space wherever whitespace separates inline content, in the form each host keeps: `{{ ' ' }}` in Vue templates, `{" "}` in JSX where a line break would drop it, and a space in Svelte markup, or `{" "}` at the edge of an `{#if}` block. Whitespace at an element's edges, beside a block-level element and among a `<select>`'s options is left for the host to condense. Svelte markup breaks lines at those spaces.

## 1.0.0-alpha.53

### Added

- Requests, as the [proposal's requests section](https://nextwebwg.org/declarative-components/javascript#requests) defines them: behavior a component asks its consumer for. A definition declares `<request name type returns>` in `<defs>`, with `<prop>` children for the detail and a `<returns type>` child for the answer in expanded form, and the contract lists it under `requests`. Its detail and answer may be `unknown` or `event` at the top level, an omitted `type` is `null` and an omitted `returns` is `unknown`. A controller asks with `host.request(name, detail, { signal, progress })`, which resolves to the answer, or `null` when nobody answers. `host.request` is present on the host of a component that declares at least one request, in the live runtime, compiled output and converted components alike, so calling it elsewhere is a `TypeError`. The detail is checked against `type` and the answer against `returns`; `null` always answers, and a mismatch or an undeclared name rejects with a `TypeError` and warns `HR007`. The request is a `RequestEvent` that bubbles from the component's root, and the nearest listener answers with `respondWith(value or promise)`, reports progress with `progress(loaded, total)`, and receives a `signal` that aborts with the asker's signal or when the asking component disconnects, which also drops a late answer. A request from inside a component whose controller has not yet run its synchronous body waits for it. An unanswered request is remembered; a page script announces a late responder with a bubbling `responder` event, or with `respond(target, name, fn)` exported from `@nextwebwg/html-next`, `/runtime` and `/browser`, and one document listener relays it, as a non-bubbling `responder` event, to each component inside the announcing element whose request went unanswered. A later `host.on(name, …)` relays the same way without an announcement, and `host.on("responder", …)` hears only that relay. The live runtime, compiled Vanilla output and converted Vue, React and Svelte components share these requests through the document, so any of them answers any other's. The build manifest lists a component with requests under the `request` capability, generated docs list its requests, and compiled `.d.ts` files type each one's event as `RequestEvent<Detail, Answer>`.
- Converted Vue, React and Svelte components accept a function prop for each request, named in camelCase (`mentionQuery`), with `(detail, { signal, progress })`, and its event form: Vue's `@mention-query`, React's `onMentionQuery` and Svelte's `onmention-query`. The host listens before the controller runs and reads the prop when a request arrives, so a new function answers the next request, and a prop or listener set later relays to the unanswered requests. The generated types give each prop the request's detail and answer types. A component that declares requests imports the generated `requests.ts`, and the request's checks use the props helper's typed-value check.
- The usage guide shows how a component asks its consumer: a mention lookup that aborts the query before it, an upload that reports progress, and late responders. A test holds the behavior in Chromium, Firefox and WebKit, in the browser runtime, compiled Vanilla output and converted Vue, React and Svelte components.

### Changed

- A definition that names an `<event>` or a `<request>` `responder`, the host event for late responders, or declares an event and a request with the same name, fails a build (`HC010`, `HC020`); the live parser warns and ignores the declaration. A request whose camelCase name equals a declared prop's fails a build (`HC011`), because a framework component takes the request's function prop under that name.
- Only a compiled or converted component that declares a request bundles the request steps. A compiled one checks each request's detail and answer with code written for their declared types, which accepts exactly what the live runtime accepts: one request adds 1.2 KB gzip to a compiled controller component. Another compiled host carries only `host.on`'s relay of a late responder, a call that does nothing until a component on the page asks (6 to 18 B gzip). The live browser bundle grows by 1.9 KB gzip.

### Removed

- The HTMLKit `folder(dir, { watch })` plugin hook is removed, with its `FolderMetadata` and `FolderContext` types. A folder takes its label and order from its index page's `hk:label` and `hk:order`, and a route group takes its label from its parentheses and its order from its number-and-dot prefix. `page.watch(file)` and `Application.watchFiles` remain for page compilers.

## 1.0.0-alpha.52

### Added

- HTMLKit plugins label and order folders. A plugin's `folder(dir, { watch })` hook runs for each folder and route group folder in a page directory, with its absolute path, and returns `{ label, order }`, such as from a `_category.json` inside it. `label` labels the folder in `navigationTree()`, in place of its name or a group's parentheses, after its index page's `hk:label` and before that page's `<title>`. `order`, a whole number, takes the place of the folder's number-and-dot prefix in `navigation()`, `navigationTree()` and `pager()`, after `hk:order` on its index page. For each field, the earliest plugin that returns one wins. The package exports the `FolderMetadata` and `FolderContext` types.
- HTMLKit plugins declare the files a page or folder depends on. `page.watch(file)` in a page compiler, and `watch(file)` in `folder()`, add a file to what `htmlkit dev` watches, inside the project root or outside it, so editing it recompiles the pages and reloads open pages. `Application.watchFiles` lists them.
- `pnpm --filter @nextwebwg/htmlkit measure:navigation` builds an 81-page site with a `<hk-nav>` of its `navigationTree()` and reports one page's document, sidebar and JavaScript bytes.
- The usage guide shows how a component contains a wrapped component's events: its controller listens on its own root in the capture phase, calls `stopImmediatePropagation()`, and dispatches its own event. A test holds the pattern in Chromium, Firefox and WebKit, in the browser runtime and in converted Vue, React and Svelte components.

### Changed

- `<hk-nav>` renders the first three levels of its items inline and each deeper level as an `<hk-nav-items>`, so a page carries a tree up to three levels deep once in `<hk-nav>`'s props. On the 81-page measurement site, a page is 155 KB (5.6 KB gzip) instead of 472 KB (15.8 KB gzip), its sidebar 78 KB (2.7 KB gzip) instead of 377 KB (11.9 KB gzip), and its JavaScript 88 KB (26.4 KB gzip) instead of 76 KB (25.6 KB gzip). Client navigation updates `current` and `open` at every level.
- Server rendering writes each component's hydration record with plain data as JSON. An array or object holding only strings, numbers, booleans, null, and arrays and objects of the same, none of which occurs elsewhere in the record, is written as itself, and other values keep their tagged form. A record of an 81-page navigation tree, as a prop input and its accepted value, is 26 KB instead of 46 KB, encodes in about 110 µs instead of 245 µs, and decodes in about 45 µs instead of 340 µs.
- Component styles select state with `:state()`, as the [Style Scoping](https://nextwebwg.org/declarative-components/styling#state) chapter now defines: `:host(:state(open))` replaces `:host-state([open])`, and `:host(:state(tone=warm))` tests a value. A value follows attribute-selector rules: an identifier is written as is, and anything else, such as `"2"` or `"cool blue"`, is quoted. Tests combine by repetition, `:host([size=sm]:state(open):state(tone=warm))`, and a malformed argument is an `HY002` error. `:host-state()` is an `HY005` error that names its replacement. `:state()` outside `:host()`, or with `of` naming another component, is not supported yet and is an `HY006` error. The live runtime, the compiled Vanilla build, and converted Vue, React and Svelte components write the same `data-<tag>-state` tokens as before.
- A component root records each explicit prop as `data-<tag>-prop-<name>`, such as `data-x-figure-prop-placement="end"`, in place of `data-<name>`. The live runtime, server rendering, compiled Vanilla output and converted Vue, React and Svelte components write the same attribute, and hydration reads it. An authored `data-*` attribute on the root, from the template or passed through by a consumer, keeps its own value, and a page selector such as `[data-placement="end"] .caption` no longer matches inside a component whose `placement` prop is `end`. A template that binds `from:data-<name>="$name"` writes that attribute as its own binding.
- Converted Vue components scope their styles as the live runtime does, with the live runtime's selectors and specificity. The styles sit in a native scope rooted at the root's tag class and bounded by every converted component's root, which carries `data-hn`. In a component with slots, the component's own markup, sanitized `$html` markup included, carries `data-hn-<tag>`; each selector's subject tests it in `:where()`, which adds no specificity, and `:slotted()` selects the content that lacks it. A component without slots emits the live runtime's selectors as they are. A rule that holds nested rules applies its own declarations in place, at its own specificity. The styles stay `<style scoped>`, with each selector in `:global()`, so Vite still leaves an unused component's styles out of a build. A Vue component that is not converted carries no `data-hn`, so its markup inside projected content is projected content to `:slotted()`, as plain markup is in the live runtime. `pnpm measure:vue-scoping` measures the selectors' style-recalc cost and the attributes' mount cost in Chromium, Firefox and WebKit.

### Fixed

- `HC021` names the page or layout whose loader returned a prop that fails its declared type, as in `` HC021: Prop `crumbs` of <trail-shell> does not satisfy its declared type ``, when the component also has head metadata, such as a layout with a closed-object `crumbs` prop rendering breadcrumbs that carry a `group` field.
- In converted Vue and Svelte components, a component selected by its tag has the live runtime's specificity, a type selector's, alone or in `:host:is(…)`: the converter emits `x-card` as `:is(x-card, :where(.x-card))`, the counterpart of the live runtime's `:is(x-card, :where([data-component~="x-card"]))`.
- In converted Vue components, `:slotted()` stops at the root of a converted component inside projected content, as in the live runtime.
- In converted Vue components, `host.refs` holds the native root of a component that a `$ref` names, as the live runtime's does, for a single ref and for each item of an iterated one. It held the component's Vue instance, and reading an iterated component ref threw.
- In converted Vue components, a literal prop on a component invocation passes the value the live runtime parses from it: a bare boolean attribute such as `<x-toolbar floating>` passes `:floating="true"`, `docked="false"` passes `false` and `count="3"` passes `3`, so the generated prop types check. A string prop stays a plain attribute. React and Svelte output already passed these values.
- In converted Vue components, an omitted list prop with no default iterates as nothing, as in the live runtime: `<li $each="item of $items" $key="$item.id">` renders no rows, and the generated component type-checks.
- In converted Vue components, a component whose root is another component runs its controller: `host.root`, `host.dispatch`, connection, `on:connect` and root focus use the root element. The controller failed to connect.

## 1.0.0-alpha.51

### Added

- HTMLKit route groups. A folder named in parentheses, such as `app/pages/docs/01.(Getting started)/`, groups its pages, and their URLs skip the folder: `01.intro.html` inside it serves `/docs/intro/`. The text inside the parentheses is the group's label, and a number-and-dot prefix orders the group among its neighbours in navigation. A group's `_layout.html` and `_layout.server.ts` wrap its pages like any folder's. Each navigation item in a group carries the innermost group's label as `group`, `<hk-nav>` shows each label as a `<li data-group>` before the group's first link, and each `ApplicationRoute` lists its `groups` (label, order and depth), outermost first. `<hk-nav>`, `<hk-breadcrumbs>` and `<hk-pager>` accept items with the optional `group` field.
- HTMLKit catch-all routes. `[...name]` matches one or more URL segments and `[[...name]]` any number, including none, and the parameter is the list of segments, as in `{ path: ['a', 'b'] }`; a catch-all is the last segment of its route. `entries()` lists catch-all pages as lists of segments for static builds. Where several routes match a URL, the first differing segment decides: a literal precedes `[name]`, which precedes `[...name]`, which precedes `[[...name]]`. The `RouteParam` type describes a parameter value.
- HTMLKit redirects. The `redirects` option maps old application paths to an application path or an `http(s)` URL, such as `{ '/start/': '/guide/' }`, and a loader's `redirect(location, status)` ends loading with a redirect, 303 unless it passes 301, 302, 307 or 308. The development server and `application.fetch` answer with the status and a `Location` header (308 for the option, with or without the trailing slash), and `render()` returns the status and `location`. A static build writes a redirect page at each old URL, with a meta refresh, a canonical link and a plain link to the new URL. The manifest's `redirects` lists each one's `from`, `to` and `status`, typed as `ManifestRedirect`, and a redirect from a page's own URL is an error that names the page.
- HTMLKit exports `loadConfig(root)`, which loads `htmlkit.config.ts` or `.js` as the CLI does and returns its options, or `{}` without a file, so a command that wraps HTMLKit can add its own plugins to a site's config.
- A page's `<meta name="hk:order" content="3">` sets its place in navigation as a number-and-dot file prefix does, in place of the file's own prefix. It orders a page among its folder's pages, and on a folder's index page it orders the folder, with all its pages, among its neighbours, in place of the folder's own prefix. On the site's home page it is an error.
- The `layouts` option names layouts beside `app/layouts/`, such as `{ home: { component, server: { load } } }`, for `hk:layout`, `layout`, `layoutDefaults` and a `pages` entry's `layout`. Each entry keeps its own loader, a `default` entry wraps every page, and a plugin's `config()` can return `layouts` too. A name resolves to the site's own `layouts` entry, then its `app/layouts/<name>.html`, then plugins' entries, earliest plugin first, so a site replaces a plugin's layout with a file of the same name.
- A loader's context has `propNames`, the props its page or layout component declares, so a loader with more data returns exactly the props its component accepts.
- HTMLKit navigation trees. `navigationTree(query)`, on the loader context and the application, returns `navigation()`'s pages in the same order, nested by folder and route group. Each `NavigationNode` has `label`, `current`, `open` (the node or a node inside it is the current page), `depth`, `order` and `children`, plus `href` and `pageName` for a page; a folder with an index page is that page's node, labelled by its `hk:label`, then its static `<title>`, then the folder name, and a group's label is its parentheses. `<hk-nav>` renders a tree as nested lists with each folder and group in a `<details>` element, open when it holds the current page, and renders `navigation()`'s flat list as before. `ApplicationRoute.title` carries the page's static `<title>`.

### Changed

- A layout name with neither an `app/layouts/<name>.html` file nor a `layouts` entry is an error that names the page and the expected file.
- `<hk-nav>`, `<hk-breadcrumbs>` and `<hk-pager>` declare their items with an open object type, which ends in `...`, and the navigation guide shows layouts the same declaration, so items keep passing through as they gain fields.
- `HC021` names the prop, the component and the type of the value it received, as in `` HC021: Prop `count` of <x-counter> does not satisfy its declared type `number`: it received a string. `` `serializePropTarget(prop, value, name, component)` takes the prop's name and the component's tag for the message, and HTMLKit passes both for the props a page or layout loader returns.

### Fixed

- In compiled components, a `$match` arm inside a `$each` row reads the row's item, so each row renders, hydrates and updates with the arm its own item selects, as in the live runtime and server rendering. `<li $each="item of $items"><template $match><a $when="$item.href">…</a><span $else>…</span></template></li>` keeps the server's `<a>` and `<span>` rows through hydration. `$if`, `$with` and nested `$each` in a row read the row's item in the same way.
- A `404` page at the top of a `pages` folder served at a prefix other than `/`, such as `/v/one/`, is no route: the site's not-found page answers that prefix's missing paths, and the folder's copy at `/` is the not-found page, through that folder's layout.
- Server rendering renders a component in a list row with list or object props, such as one that renders itself for nested items. Rendering repeats its update and lowering passes until a pass lowers no further component, so the row's component takes its props and renders its content.
- A compiled Vanilla component that invokes itself compiles to one module that calls its own factory.
- In converted Vue components, every `:host` rule has the live runtime's specificity: `:host`, `:host(…)`, and either one under an ancestor selector or with a pseudo-element. The converter emits the root as `:scope:where(:scope)`, which Vue's scoped styles turn into `:scope:where([data-v-…]:scope)`, the counterpart of the live runtime's `:scope:where([data-component~="…"])`, and puts the rule's other tests and ancestor context in an `:is()` after it, so `.wide :host(.on)` is `:scope:where(:scope):is(.wide .on)`. A consumer rule more specific than a component's `:host` rule applies to the root in converted Vue components as it does in the live runtime.

## 1.0.0-alpha.50

### Added

- A component's native root takes `on:connect` and `on:disconnect`. Each names a handler that runs every time the component connects to, or disconnects from, a document, again after a reconnect, as a controller's `host.on("connect")` and `host.on("disconnect")` do; a handler that reads `$$event` gets an `Event` of that type. The live runtime, compiled Vanilla output and converted Vue, React and Svelte components run them, and server rendering never does. On any other element, on a delegated or `$match` root, or with modifiers, the bindings are an `HT010` error.

### Changed

- The converter README says what converted Vue components emit: each declared event as the same `CustomEvent<T>` dispatched on the root, plus `update:<prop>` for `v-model:<prop>`.

### Fixed

- In converted Vue components, a `:host` or `:host(…)` rule under an ancestor selector, such as `.wide :host` or `.wide :host::after`, matches the component root and its pseudo-elements, as in the live runtime and the compiled Vanilla build. The converter emits the ancestor test on the root, `:scope:not(:not(:is(.wide *)))`, with the same specificity, so Vue's scoped styles put the scope attribute on the root rather than on the ancestor.

## 1.0.0-alpha.49

### Added

- HTMLKit nests layouts from the page tree. A folder's `_layout.html` wraps every page in that folder and below it, inside its parent folders' layouts, with an optional `_layout.server.ts` loader; loaders run from the outside in and pass `data` on as `parent`. The layout a page selects (`hk:layout`, a `pages` entry's `layout`, `layoutDefaults`, the `layout` option, or `app/layouts/default.html`) stays outermost, with the folder layouts inside it, and `none` or `false` renders the page with no layouts. Client navigation between pages that share folder layouts keeps them, with their state and controllers.
- HTMLKit plugins can run build steps. `buildStart({ command, root, base })` runs before HTMLKit reads any page, once per `htmlkit build` and once when `htmlkit dev` starts, so a generator's pages and data are part of the site. `buildEnd({ root, base, outDir, routes, pages, writeFile })` runs after the build writes every page, asset and the manifest to its staging directory, before the output replaces `outDir`. `writeFile(path, contents)` adds a file such as a sitemap or search index and refuses a path outside the output, in `_htmlkit/`, or at an existing file. A hook that throws fails the build with an error naming the plugin and hook, and the previous output stays in place.
- `_htmlkit/manifest.json` is a documented, versioned format (`version: 1`, `base`, `routes`, and each page's `pathname`, `pageName`, `browserModule` and `chunks`), described in the configuration guide. `readManifest(outDir)` reads it, refusing an unknown version, and the package exports its `BuildManifest` and `ManifestPage` types, with `BuildStartContext` and `BuildEndContext`.

## 1.0.0-alpha.48

### Added

- HTMLKit renders `app/pages/404.html` for every URL that matches no page, through its layouts and with status 404, in development, `preview`, and `application.fetch`, and `htmlkit build` writes it to `404.html`. It is not a route: `/404/` is not served, listed in navigation, or included in the manifest. `Application.notFound` exposes it. Without the file, the built-in "Page not found" page is unchanged.

### Changed

- The HTMLKit guide corrects four points. The `/about` → `/about/` redirect happens in development, `preview`, and `application.fetch`, but not on a static host. `preview` takes its base path from the build. A page's head tag replaces the layout's tag with the same identity, rather than every `<meta>`. Under HTMLKit, a component using `transitions` fails to build (`HT024`), because HTMLKit doesn't enable extensions yet. It also states the default port and flag precedence.

## 1.0.0-alpha.47

### Changed

- HTMLKit pages ship their components compiled to direct DOM code instead of the live runtime and serialized definitions. Each page's module imports only its compiled components and the `generated-runtime` helpers they use, and pages share the modules of the components they have in common. The first page's components adopt the server-rendered DOM in place, so what a reader typed before startup, focus and selection survive, then controllers connect and reads start. Client navigation renders each payload's layers with the components' factories, with the same markup as a document load, keeps shared layouts with their state and controllers, and adopts the HTML fallback in place. On HTMLKit's examples, each page ships 19.0 to 26.7 KB of gzip JavaScript instead of 49.7 to 53.8 KB (`pnpm --filter @nextwebwg/htmlkit measure:delivery`).

### Added

- `@nextwebwg/html-next/generated-runtime` exports `replaceProjectedNode`, `adoptRenderedProps` and `generatedHost` for compiled roots, as the live runtime's `replaceProjectedNode`, `adoptRenderedProps` and `getComponentHost` serve live ones. `adoptRenderedProps` takes the new rendering's root from a factory or from server HTML.

### Fixed

- A compiled component renders what changed between its construction and its first connection, such as a list of objects its parent binds to it, which reaches it after construction. It rendered nothing for those changes until the next one.

## 1.0.0-alpha.46

### Changed

- `@nextwebwg/html-next` depends on jsdom 30.1.2 (was 30.0.1) for server rendering and @dprint/formatter 0.6 (was 0.5) for formatting generated components.

### Fixed

- A DOM node in state, such as an event's `target`, an element from `$ref`, or a node held in data, is stored and read as it is in the live runtime and compiled components, as native events already are. It was wrapped in a reactive proxy, and reading a native property through it (`$$event.target.textContent`) threw in browsers, which reject a proxy as a native getter's receiver.

## 1.0.0-alpha.45

### Fixed

- A handler `<set>` whose value is a number that is not finite is an invalid result in the live runtime and compiled components, as in Vue, React and Svelte conversion: the state keeps its value and nothing warns. `<set name="count" expr:value="$$event.target.valueAsNumber">` on an emptied `<input type=number>` previously warned `` HR007: State `count` does not satisfy its declared type. ``, which remains the warning for a value of the wrong type.

## 1.0.0-alpha.44

### Changed

- Converted Svelte components carry their styles in their own `<style>`, scoped by classes rather than `data-component`, as converted Vue components are: a styled component's root carries its tag as a class, the `@scope` root, and each component its template invokes carries its own, the scope's limit. Each selector is `:global()`, so Svelte keeps rules for markup it cannot see, such as sanitized HTML. In a component with slots, Svelte's hash class tells the component's own markup from content a consumer projects: ordinary selectors require it, and `:slotted()` selectors require its absence. Imported stylesheets join each component's `<style>`, so the converter no longer writes a `.css` file beside each Svelte component or a shared `svelte/shared-components.css`. A controller's `host.slots` finds its projected nodes without `data-component`.
- The quick-start guide is shorter. `counter.html` is followed directly by the component each framework generates, with one line and a setup link per framework, so switching frameworks changes the code right under the switch. The paragraphs between the source and the output and the separate "Use what you built" section are removed.

## 1.0.0-alpha.43

### Changed

- Vue, React and Svelte conversion write a handler's `<set>` as one plain statement whenever the converter proves its value satisfies the state's declared type, with no runtime check: a literal, a negation into a `boolean` state, a copy of a same-typed state, a `number` state stepped by a number literal, an `integer` state stepped by a safe integer, and any write to an untyped state. The quick-start counter's `$count + 1` is `count.value = decimalAdd(count.value, 1)`, `setCount((count) => decimalAdd(count, 1))` and `count = decimalAdd(count, 1)`; an `integer` counter is `count.value++`, `setCount((count) => count + 1)` and `count++`. A stepped state must never be absent, so no controller and no unproven write may write it. Any other write is one call to the shared `write` helper, `write(total, label.value, isNumber, 'writes.html', 'wrong', 'total')`, which replaces `acceptsWrite` and its temporary variable. The converted conformance corpus has 2 checked writes per framework instead of 9 or 10, and is 0.9 to 2.0% smaller gzipped.

### Fixed

- A converted handler write of the wrong type warns as the live runtime does, `` writes.html: HR007: State `total` does not satisfy its declared type. ``, once per authored write: per file, handler and state path. Converted components previously shared one warning across files that used the same handler and state names.
- A converted handler write of a number that is not finite is an invalid result, as in the live runtime: the state keeps its value and nothing warns.
- React conversion accepts any value written to an untyped state, as the live runtime and the other frameworks do. It previously refused a value of another kind than the state's initial value.

## 1.0.0-alpha.42

### Breaking

- Number arithmetic in expressions is decimal to the operands' precision, as the proposal now specifies. `+`, `-` and `%` give the exact decimal result at the larger operand's decimal places, and `*` at the sum of both, so `1.1 + 0.1` is `1.2`, `0.1 + 0.2` is `0.3`, `0.1 * 0.2` is `0.02` and `0.3 % 0.1` is `0`, where JavaScript gives `1.2000000000000002`, `0.30000000000000004`, `0.020000000000000004` and `0.09999999999999998`. A state stepped by `$level + 0.1` reaches exactly `9.9`. `/` keeps full double precision, whole numbers calculate as before, dimensions follow the same rule (`1.1px + 0.1px` is `1.2px`), and a result that would need more than 15 significant digits stays the double result. The live runtime, server rendering, compiled components, and Vue, React and Svelte conversion all calculate this way.

### Added

- `@nextwebwg/html-next` exports `add`, `subtract`, `multiply` and `divide`, the operations expressions use, so controller code can calculate what an expression would. They never throw: `divide(1, 0)` is `Infinity`, which a `number` declaration rejects. Compiled components import the ones their expressions use from `@nextwebwg/html-next/generated-runtime`, and none for arithmetic on whole numbers (integer literals and `integer` values). Converted components import them from their shared host module as `decimalAdd`, `decimalSubtract`, `decimalMultiply`, `decimalDivide` and `decimalRemainder`, so authored names such as an `add` handler keep their names. A compiled component that uses one operation grows by about 230 B gzip, and one that uses all of them by about 290 B; the live runtime grows by 0.3 KB gzip, and an application of every converted conformance component by about 300 B in each framework. Fractional arithmetic takes about 20 to 35 ns longer per operation; whole numbers take no longer.

### Changed

- CI selects changed packages and their transitive consumers, keeps pure shared-version changes from widening functional tests, separates Node and packed-consumer checks, and splits browser regressions into measured parallel batches. Routine checks target five minutes; the automatic verification and publication path has a fifteen-minute execution budget. Broad converter corpora, OS/Node compatibility matrices and rendering benchmarks run manually. npm publication waits for CI to pass on the exact main commit and skips already-published releases.

## 1.0.0-alpha.41

### Breaking

- HTMLKit metadata uses the `hk:` prefix: `hk:page`, `hk:layout`, `hk:label`, `hk:navigation`, and `hk:alias`. The old `htmlkit:` spelling is an error that names its replacement. Rendered layers have `hk-layer-N` ids, and the browser event is `hk:ready`.
- The navigation component is `<hk-nav>`, after the `<nav>` it renders, in `components/nav.html`. It and HTMLKit's other built-in components need no component link, and the `hk-` prefix is reserved for them.
- `@/` is the project root in component links, controllers, stylesheet imports, and loader imports. HTML Next's Node loader accepts an application `importMap`, as its browser loader does, and HTMLKit passes `@/` through it and to Vite.
- Ordering prefixes are a number and a dot, and always apply: `01.guide/02.install.html` routes to `/guide/install/` and orders navigation. The `routeOrdering` option is removed. A dash no longer marks an ordering prefix, so rename `01-guide` to `01.guide`; a name such as `2024-recap` keeps its URL.
- `$if`, `$with` and `$match` rebuild their content only when the decision changes, in the live runtime and compiled output alike. The decision is the `$if` result, the chosen `$match` arm, or the text of a dynamic slot name in the content. Any other change updates the content in place. Previously, any change to what the decision read rebuilt it. Under `<div $if="$count > 0"><input></div>`, changing `count` from 1 to 2 no longer replaces the `<input>`, so typed text, focus and selection survive. Nested components are no longer re-created. `$with` and `$match` aliases update in place. Compiled output also rebuilds a `$match` arm when a slot name inside it changes, as live does. React conversion keys nested `$match` arms, so switching between arms of the same shape renders the new arm afresh rather than reusing the old arm's elements.
- Attribute, class, style and text bindings, `$value` and `$html` write only a result that differs from what they last wrote, in the live runtime and compiled output alike. Previously the live runtime rewrote the same value whenever something the binding read changed, and compiled output did so for `$html` and for class toggles on an element that also binds `class`. An unchanged `$html` no longer replaces its content, so focus and selection inside it survive. Property bindings and bound control values still write each new result.
- A `<data>` read requests again only when one of its `from` parameters resolves to a different value. Previously any change to what a `from` parameter read restarted the request, even when the URL stayed the same. Reconnecting still requests.

### Added

- The optional `transitions` extension animates what `$if`, `$each`, and `$match` add, remove, and move. `$transition` takes a keyframes name (a built-in `fade`, `fly`, `scale`, or `blur`, or any `@keyframes`) with an optional duration, easing, and delay; leaving plays it in reverse. `$transition-name` gives an element an identity, so one element can morph into another. The Vite plugin builds it with `extensions: ["transitions"]`, and `html-next-check` with `--extension transitions`. Without the option the directives fail `HT024`; an unknown extension name fails `HN013`, and a malformed value `HT025`. The live runtime and Vue, React, and Svelte conversion warn and build without animation. Components that do not use the directives compile exactly as before; the shared support every compiled component bundles grows by 4 B gzip. See the new Transitions guide.
- Compiled components can hydrate server output. With `generateComponent(definition, { hydrate: true })`, a component's factory takes a server-rendered root as its third argument, `create<Name>(options, html, root)`, and binds that DOM in place instead of creating its own. Hydration restores the instance's props and state from `data-html-next-instance`, adopts conditions, list rows, slot ranges, fallbacks, scoped renderings and nested components where the server rendered them, and keeps control values, focus and selection edited before startup. Each root connects, and its controller runs, once the outermost hydration has finished, in document order. A block whose server markup does not match its template is created afresh in its place. Modules generated without the option are unchanged.
- The quick-start guide shows the Vue, React and Svelte component each adapter generates from its `counter.html`. `pnpm generate:quick-start` writes them, and `pnpm check:generated` fails when the guide shows output the converters no longer generate.

### Changed

- HTMLKit inlines an optional `app/head.js` as a classic script after each page's charset declaration and before its stylesheets, so it runs before first paint, for example to apply a saved color theme without a flash of the default one. Text that would end or nest the script (`<!--`, `<script`, `</script`) is rejected.
- HTMLKit applications serve pages through `application.fetch(request)`, which takes a native `Request` and returns a `Response` on Node, Deno 2.8+, and Bun. The development server uses it for every page, and CI runs it on Deno and Bun.
- The HTMLKit development server's component stylesheet links load again. Vite requests them with a `?direct` query that HTMLKit's virtual sources did not recognize, so they returned 404 and each dev page first painted without component CSS until its module injected the styles, fading any transitioned colors in.
- HTMLKit plugins add page formats. A plugin's `pages` compiler claims file extensions such as `.md` and turns each file into an HTML Next page resource; HTMLKit then routes, orders, watches, renders, and builds those pages like `.html` pages. While compiling, a page can resolve another page's URL with `page.href` and serve a referenced file with `page.asset`. A plugin's `config()` contributes options, including a layout whose loader is a module object and a `headScript` inlined before `app/head.js`.
- `pages` lists the page directories and the URL prefix each serves, defaulting to `app/pages` at `/`. One directory may serve several prefixes.
- Pages can set their navigation label (`hk:label`), stay out of navigation (`hk:navigation` with `content="hidden"`), and add alias routes (`hk:alias`). An alias never appears in navigation and marks its page's own entry current.
- HTMLKit's `css` option adds page-wide stylesheets to every page, such as `['@/styles/page.css']`, for rules like `html` and `body`. They load before the page is shown, in builds and in development.
- HTMLKit plugins compose with the site: page folders, stylesheets, and routes a plugin adds join the site's own instead of replacing them, and `app/pages` stays. A page folder can name its own `layout`, which its pages use unless they name one, so a plugin's layout no longer wraps the whole site. `optional: true` skips a folder that doesn't exist.
- HTMLKit has built-in `<hk-breadcrumbs>` and `<hk-pager>`, unstyled and accessible like `<hk-nav>` and needing no component link. Loaders get `breadcrumbs()`, the existing pages from the home page (or `from`) down to the current one, and `pager()`, the pages before and after it in navigation order.
- HTMLKit navigates between pages in place, as Nuxt does. After the first page hydrates, a link to another page under the base loads that page's browser module and its data payload, renders the page in the browser with the server's own steps, keeps every layout the two pages share with its DOM, state, and controller, and swaps the rest. A kept layout takes its loader's new props, so `<hk-nav>` marks the new page current. The title and head metadata follow the new page, and screen readers hear its title. It uses the Navigation API (Chrome 135, Firefox 147, Safari 26.2), so back and forward, scrolling, and focus behave as for document loads; older browsers and readers without JavaScript keep loading whole pages.
- Builds write each page's payload to `_htmlkit/pages/<route>/payload.json`, and `application.fetch` (so `htmlkit dev`) serves it from the same render: the head, and each layer's component, prop attributes, and loader state. Loader `data` stays private. A payload is about 0.5 KB gzip where the docs proof's HTML is 1.4 to 4.6 KB. A page whose payload is missing or fails, or that cannot render from it, loads from its static HTML, and one that cannot render in place at all (missing, failed, or redefining a component already on the page) loads as a document. `RenderedPage` gains `layers`, and the build manifest lists each page's shared `chunks`.
- The `prefetch` option chooses what links load before a click: `interaction` (the default) loads a page's payload and module when its link is hovered or focused for 80 ms or touched, and only shared chunks for links on screen; `visible` also loads payloads and modules for links on screen; `none` loads nothing. `data-hk-prefetch` on a link or an ancestor overrides it. Prefetching never runs a page's code. Other sites, other base paths, files, downloads, new tabs, modified clicks, same-page fragments, posted forms, and links inside `data-hk-reload` load normally. An author's `@view-transition { navigation: auto; }` animates client navigation too. The client and the runtime functions it uses add 4.4 KB gzip (10%) to the first page; `docs/client-navigation.md` records the design and measurements.
- HTML Next's `adoptRenderedProps(element, rendered)` applies the props a fresh server rendering recorded on a component root to a live instance a framework keeps, through the `updateComponentProps` channel, without resetting its state or DOM.
- HTML Next's `replaceProjectedNode(current, next)` replaces a node a live component projects into a slot, in the document and in the component's projection: the new node is marked for slotted styles, appears in `host.slots` and the rendered form, and is what the slot renders if it renders again. Replacing projected content with `replaceWith` left the component projecting the old node.
- HTMLKit names a page's shared-import stylesheet for its whole component graph. Pages under one layout shared a name, so a build linked every such page to the last page's styles, and development served whichever page rendered last.
- `buildApplication()`'s `browserInputs` lists only source files. It also listed HTMLKit's virtual component stylesheets, which a tool reading each input could not open.
- A parent that passes a child component the value it already has no longer re-runs the child's prop validity, or rewrites its `data-*` reflection, in the live runtime and compiled output alike. The `data-valid`, `data-invalid`, `data-user-invalid` and `aria-invalid` markers, and `data-*` prop reflections, are written only when they change. In the live runtime, a `$each` row keeps its `loop` record through list updates, and only the fields that change are written, so `$loop.index` readers no longer re-run when only the count changes.
- Vue, React and Svelte conversion follow the same rules for unchanged values. A `<data>` read requests again only when a `from` parameter changes; React previously also requested when only an `expr` parameter changed, and Vue and Svelte whenever a `from` parameter's inputs changed. In React, a computed value that recomputes to the same result no longer reruns the effects that read it. In Vue and Svelte, an effect that reads one prop no longer reruns when another prop changes. Writing a value read from `host.state` back to it is no change. Svelte attribute and style bindings write only a changed result.
- React conversion tracks what a controller reads from `host.state` path by path: `items.push(…)` or `items[1].name = …` no longer reruns an effect that read only `items[0].name`, while assigning a new list still does. A controller's `host.computed` notifies only when its value changes. Converted React inputs and textareas skip renders that change none of their props, so React no longer rewrites their `name`, `type` or default on every update, and bound controls take their authored defaults while mounting. In every converter, bound controls, select options and the `aria-invalid` mirror write their defaults only when they differ, and in Svelte a `NaN` that stays `NaN` counts as unchanged.
- A `<data>` read requests again when a whole list sent as a `from` parameter changes in place: after `tags.push("b")` or `tags[0] = "z"` under `<param name="tags" from:value="$filter.tags">`, in the live runtime and compiled output alike. Compiled output previously requested again only when a new list was assigned, and the live runtime tracked the list's items only as a side effect of building the request. A list passed whole to a child prop already followed its items in both.
- Compiled output no longer throws `TypeError` when a `$match` of two or more arms with no `$else` has chosen no arm and another value it does not read changes.
- A new guide page, Versions and stability, says that alpha releases follow the proposal's live draft and may break components, sets out what 1.0 will promise within a major version, and shows how a library declares the tools versions it supports (`peerDependencies` today; the planned `htmlNext.snapshot` and `htmlNext.extensions` fields) and how extensions will be enabled. The READMEs, the library publishing guide, and the release mechanics link to it.
- Converted Vue components read like hand-written Vue. The quick-start counter converts to `const count = ref(0)`, `count.value = 0`, a two-line checked `count.value + 1`, and `Count: {{ count }}`. Rendering and binding helpers (`nativeAttrs`, `checkHydratedRoot`, `acceptsWrite`, `isNumber`, `text`, `KeyedBoundary` and the rest) come from the shared `vue/host.ts` rather than being repeated in each component. A string, number, integer or boolean state with a conforming literal initial value is no longer checked on each read, since every write to it is checked in full; structured states keep their read checks, because a handler write checks only their own kind. Across the conformance corpus the generated Vue is 55 KB (previously 135 KB), and an application of all its components ships 16.8 KB gzip (previously 20.6 KB); a single small component bundled alone is about 100 bytes larger.
- Converted Vue components mark their style scope with classes rather than `data-component`: a styled component's root carries its tag as a class, the `@scope` root, and each component its template invokes carries its own tag, the scope's limit. A selector naming a component by tag selects that class. The proposal treats both as target styling markers.
- Converted Vue templates write text as authored, such as `Count: {{ count }}`, and follow Vue's whitespace handling: each authored run of ASCII whitespace renders as one space, and indentation at the start and end of an element's text goes, so `textContent` differs from the live runtime's where the source indents or repeats spaces. A space between an element and the text after it stays, and non-breaking spaces and `<pre>` and `<textarea>` text are kept exactly.
- Converted React components import their rendering and binding helpers (`text`, `RetainedValue`, `KeyedBoundary`, `cycleCheckedComputed`, `renderPlainSlot`, `warnUnless` and the rest) from a shared `react/render.tsx` instead of defining them in each component, where the expression helpers were re-created on every render. The output is formatted, and mixed template text is one template literal (``{`Count: ${text(count)}`}``), which renders as the single Text node the live runtime creates. As in converted Vue, each authored run of ASCII whitespace in template text renders as one space and indentation at the start and end of an element's text goes; non-breaking spaces and `<pre>` and `<textarea>` text are kept exactly. Across the conformance corpus the generated React is 43.8 KB gzip (previously 62.0 KB), and an application of all its components ships 21.4 KB gzip (previously 25.9 KB).
- Converted React components use the names their source declares. A `count` state is `const [count, setCount, getCount] = useLiveState(0)`, an `increment` handler is `function increment()`, and an element that only listens takes its ref from `useNativeEvents([...])`. A handler write is `const next = getCount() + 1` and one `acceptsWrite(...)` line, and a literal the state accepts is a plain `setCount(0)`. A root with nothing to attach takes `ref={rootRef}`, and state contexts render as React 19 `<Context value>` elements.
- Converted React and Svelte components skip the read check on a string, number, integer or boolean state with a conforming literal initial value, as Vue components and the compiled build do.
- Converted Svelte components read like hand-written Svelte. The quick-start counter converts to `let count = $state<number>(0)`, `count = 0`, a two-line checked `count + 1`, and `Count: {count}`, with `{#each rows as { item: n, index: i }}` loops and authored `$with` and `$match` aliases. Rendering and binding helpers (`rootAttributes`, `acceptsWrite`, `isNumber`, `text`, `retainedValue`, `writePath`, `setProperty` and the rest) come from a shared `svelte/render.svelte.ts` rather than being defined in each component, and the root's attributes, `data-component` token and `constructor`/`__proto__` attachment are one `{...rootAttrs()}` spread. Scripts are formatted; markup breaks lines inside tags, since Svelte renders whitespace between elements as a space. Text follows Svelte's whitespace handling, as in Vue; `<pre>`, `<textarea>` and `<option>` text is kept exactly. Across the conformance corpus the generated Svelte is 36.0 KB gzip (previously 61.9 KB), and an application of all its components ships 24.5 KB gzip (previously 31.9 KB); the counter bundled alone is 68 bytes larger.

### Fixed

- Hydration by the live runtime adopts a `<template $each>` row's server nodes instead of rendering the row again beside them, which showed each row twice.
- A compiled component evaluates an empty object or list literal (`format($names, 'list', {}, $locale)`, `format([], 'list')`) and a call with no arguments as the live runtime does. They compiled to a missing argument, so the call rendered nothing.
- The `html-next` and `html-next-convert` commands run when started through their installed `node_modules/.bin` link, as `npx`, package scripts and direct calls do on macOS and Linux. Earlier releases exited there without output or files.
- Whitespace-only text inside `<pre>`, `<listing>`, `<textarea>`, `<xmp>`, and `<plaintext>` is kept in live loading, SSR, HTMLKit pages, compiled output, and Vue, React and Svelte. Before, the template parser dropped it, so a Shiki code block's `\n` between its `.line` spans disappeared and every line rendered as one. Vue output also no longer adds a newline between adjacent elements inside them, which split a highlighted line at each token. Elsewhere, whitespace-only text between elements is still dropped.
- Converted React `$html`, `textContent` and form-control bindings keep their last value when an expression produces an invalid result, as text bindings already did. Before, they kept it only when the expression read a declared value that could fail its type check.

- The shared `vue/host.ts` typechecks under `exactOptionalPropertyTypes`.
## 1.0.0-alpha.40

- Component CSS prevents Firefox 155's scoped SVG class rules from leaking across scope limits. Live loading, graph CSS, Vite, SSR, React and Svelte keep owned, projected and nested component styling distinct through DOM moves. The compiler uses a Firefox-specific private CSS marker; shared boundary rules are delivered once per graph or live document. Author inheritance remains intact; no DOM observers or ownership attributes are added. Mozilla bug 2080046 tracks the underlying browser defect.

## 1.0.0-alpha.39

- Shared and inline component styles preserve stylesheet-local `@namespace` declarations in live loading, Vite builds, SSR, and framework conversion. Imported default namespaces become explicit selector constraints; conflicting named prefixes remain isolated. Firefox 155's native SVG scope-limit defect is documented with a standalone reproduction and Mozilla bug 2080046.

## 1.0.0-alpha.38

- Component styles support shared CSS with ordinary `@import`. Live loading, Node graphs, SSR, HTMLKit, native Vite builds, and framework conversion resolve nested imports before scoping, retain source-relative assets and import conditions, and reuse source fetches. Compatible uses share one delivered body; distinct layers, conditions, cascade positions, global overrides, and target scope boundaries retain separate occurrences when needed. Styles follow graph order and stay in place when instances move or remount. Synchronous compilation diagnoses unresolved imports instead of emitting global imports. Imported `@namespace` is currently HY004 because flattening it would change selector matching.
- Component style compilation preserves conditional and layered name-defining rules, including keyframes, in source order. Zero-specificity owner and pseudo-element guards prevent Firefox scope-boundary leaks and stale root styles. Defaults remain explicit CSS; no automatic box-model reset is installed.

## 1.0.0-alpha.37

- Vue component styles preserve native selector boundaries: ordinary selectors match owned descendants, while root elements and their pseudo-elements require explicit `:host` selectors. Nested component roots remain outside the parent’s style scope, and Vue slot scoping is preserved.
- Compiled components update rows inside a nested `$each` when an outer row moves, or when its item or an outer state value changes, as the live runtime does. Before, `<li $each="row, i of $rows"><b $each="n of $row.tags">{$i}</b></li>` kept each row's old `$i` after a reorder (and showed `undefined` at first), an inner row's `{$row.label}` missed writes to that row's `label`, and rows two loops deep missed state changes. Rows keep their position only when something in or below them reads it. A reorder re-runs only the moved rows' position bindings, and a count change only rows that read `loop.count` or `loop.last`.
- Compiled lists whose rows read their position visit only the rows a reconcile moved: an append or a pop leaves every existing row alone. This adds 15 B gzip to keyed list output.

## 1.0.0-alpha.36

- `bind:` writes through a `$each`, `$with`, or `$match` alias of a state path, as the proposal specifies. `<div $with="$draft.owner as owner"><input bind:value="owner.name">` writes `draft.owner.name`, and `<li $each="row of $rows"><input bind:value="row.label">` writes that row's `label`, in the live runtime, compiled output, and Vue, React and Svelte. An item of a `$where`, `$sort`, or `$limit` list, and an outer loop's item written from an inner loop when the outer loop names no index, are `HT005` with the reason; name the outer loop's index (`row, i of $rows`) to write through it. Replacing a whole loop item (`bind:value="tag"` over a list of strings) is also `HT005` for now; bind one of its fields. Compiled output writes a row's field through the row's item, so no row has to keep its position for it. A `$with` alias that shares a state's name no longer writes that state.
- Components parsed in the browser log `HT022` to the console when a bare keyword spells a name in scope, so a missing `$` shows up without running `html-next-check`. The message quotes the expression.
- Rebuild brand symbols and lettering with clean vector geometry, removing jagged raster-trace edges while preserving the approved N spacing.

- HTML Next has approved vector and PNG brand assets, separate symbol-only avatars and full name lockups, and a branded repository introduction.

- HTMLKit has a guide at [nextwebwg.org/htmlkit](https://nextwebwg.org/htmlkit/), authored in `packages/htmlkit/docs/guide`: routes and layouts, loaders and browser delivery, ordered routes and navigation, and configuration. The package README now links to it and states the supported Node range, `>=22.22.2 <23 || >=24.15 <25`.

## 1.0.0-alpha.35

### Breaking

- A `$sort` key is a path from the loop item, so a field can no longer be confused with the item: under `$each="p of $products"`, write `$sort="p.price,-p.name"`, and `$sort="p"` to sort by the item itself. A bare field such as `$sort="price"` is a parse error (`HT023`) that suggests `p.price`. Like `bind:` and `<set name>`, a key accepts a leading `$` even though it is not required (`$sort="$p.price"`).

### Changed

- The performance guide publishes js-framework-benchmark results again, measured on 1.0.0-alpha.34's default Vite build: 0.936× Solid, 0.920× Svelte, 0.861× Vue and 0.711× React Hooks, from 8,862 gzip bytes, with the raw results in the benchmark ledger.
- CI runs the browser suites in Playwright's container image for the locked Playwright version, which already holds the browsers and their system libraries. A slow Ubuntu package mirror no longer holds a browser check past its 15-minute limit.

## 1.0.0-alpha.34

### Breaking

- Expressions read a declared value only as `$name`, as the proposal specifies. A bare word inside an expression is now a keyword literal: `from:title="count"` sets the text `count`, and `{ label: name }` holds the keyword `name`. Add `$` to every reference in `from:`, `class:`, `style:`, `.prop`, `expr:value`, `<computed from>`, `$if`, `$when`, `$where`, `$limit`, `$key`, `$value`, `$html`, the `$each` list, the `$with`/`$match` subject, and `{…}` text. Loop items, `as` aliases, declaration and handler names stay bare.
- `bind:` and `<set name>` are path fields, not expression fields, and are written without `$` (`bind:value="search.query"`). A bracketed segment inside a path is an expression: `rows[$selected].name`. `$sort` keys are unchanged.

### Changed

- Every HTML Next package now requires Node `>=22.22.2 <23 || >=24.15 <25` (previously `>=22.13 <23 || >=24 <25`), the Node 22 and 24 releases that jsdom 30 supports. 1.0.0-alpha.33 already uses jsdom 30 for server rendering.
- A component slotted into a slot that is closed at first render lowers when the slot opens, and a slot that closes and renders again re-inserts the lowered component rather than its raw invocation. Hidden slotted content creates no instance or bindings until a slot renders it.
- A consumer's `<template slot>` renders lazily for every slot, including one that exposes no props. Previously such a slot inserted the inert `<template>` and its content never rendered. The children render in the consumer's scope only while the slot renders, afresh each time, and nothing inside is created, fetched or bound while the slot is hidden. `host.slots` lists the elements the template renders while its slot renders, and none otherwise; for a slot with props it previously listed the `<template>` itself. Plain projection stays eager.
- The quick start, counter example, and `@nextwebwg/html-next` README reference state with `$` (`{$count}`, `expr:value="$count + 1"`).
- Builds compile every component to direct DOM code with the live runtime's semantics: controllers, state, computeds, `$if`, `$match`, keyed and unkeyed `$each`, `$html`, props, slots, component invocations, declared data and contexts. The `experimentalDirectExtend` option and the general-runtime fallback are removed, and the build manifest no longer has a `directExtend` field. Compiled roots are visible to `getComponentHost`, `inspectInstance` and `serializeRenderedForm`, and hydrate live.
- Components that the smaller static, primitive-state and scalar-prop emitters compiled now render exactly as live does. Slot ranges are marked, prop validity uses live's messages and validity API, and inspection and hydration see them. Such a component alone bundles about 6.9 KB gzip of shared support, or 11.3 KB with props, paid once per application.
- A controller's write through `host.state` into a computed or context value, nested writes included, is refused with a read-only warning, as in the live runtime.
- Compiled components follow the live runtime's slot rules. A consumer's `<template slot>` renders only while its outlet renders, `host.slots` lists what it renders, and a component projected into a slot is created only once a slot places it.
- A compiled component bundles only the type checks its declared props and events use, not the type-expression parser, literal parser, unused formats or color keywords. Live type checks are built from the same combinators and are about 10% faster.
- A document has one MutationObserver for connection tracking, shared by the live runtime, compiled components and the React, Svelte and Vue targets. Bound `<select>` elements in the Svelte and Vue targets share one observer per document for their option lists.

### Added

- A structured attribute value accepts bare keywords as keyword literals, checked against the declared type: `<state value="{ mode: compact, tags: [red, blue] }">`.
- `html-next-check` reports warnings as well as errors. `HT022` warns when a bare keyword spells a name in scope (did you mean `$count`?). Warnings carry `severity: "warning"` and leave the exit status at `0`. `checkConversion` passes them to an optional `onWarning` callback.

## 1.0.0-alpha.33

- Simplify the public performance documentation and package READMEs.
- Server rendering uses jsdom 30.0.1 (previously 27.4.0). jsdom 30 declares Node `^22.22.2 || ^24.15.0`, narrower than HTML Next's `>=22.13 <23 || >=24 <25`.
- `@nextwebwg/html-next-unplugin` depends on vue-tsc 3.3.12 (previously 3.3.11).
- Generated React components typecheck in TypeScript 6+ projects that do not declare `*.css`, and the unplugin's generated declarations no longer import stylesheets.
- `html-next-check`, installed with `@nextwebwg/html-next-unplugin`, checks native, Vue, React, and Svelte component graphs without writing build output. One run reports independent declaration, binding, resource, and backend errors as source links or JSON, for CI and editor adapters to run beside TypeScript.

## 1.0.0-alpha.32

### Changed

- Validation leaves application stylesheets untouched: it no longer reads connected or adopted stylesheets, observes stylesheet changes, copies rules, or patches CSSOM methods. `installValidityStyles` is removed. Component styles still transform validity selectors when compiled; call `rewriteValiditySelectors` on any shared application CSS that uses them.
- Templates and keyed lists read reactive state as plain objects, and a row gets a proxy only when controller JavaScript touches it. Controllers still receive one canonical proxy per object. Writing an object's proxy over the object itself (`rows[0] = rows[0]`) is now no change. A getter defined directly on a plain object runs with the plain object as `this` when a template reads it, and its reads are not tracked; class instances still read through their proxy.

### Added

- `renderComponents()` returns `styleOwnership`, the component tags and tested state names for its CSS. Hydration reuses explicitly owned server-delivered component CSS, including one bundle shared by several components, instead of compiling and injecting it again.
- Experimental `experimentalDirectExtend` build option compiles components with controllers, state, `$if`, and keyed `$each` lists to direct DOM code. It is off by default. If any component in a graph is not yet supported, the whole graph builds exactly as it does without the option.

### Improved

- Selecting a keyed row updates only the previously and newly selected rows when a class binding compares the loop key for equality, in the live runtime and compiled output.
- Live list rendering keeps less bookkeeping per row and per list: proxies share one trap handler, keyed blocks keep their own positions, and removed nodes are checked against connected component roots without walking each removed subtree.

### Documentation

- The package READMEs introduce HTML Next more directly and summarize its js-framework-benchmark results, with the full receipts in the guide.

## 1.0.0-alpha.31

- Browser adoption retains parent refs, reactive bindings, declared child props, and events on nested components rendered as native roots, whether the nested component is adopted before or after its parent. Bindings and refs follow child root replacement without replacing projected content.
- Reactive list rendering does less work per row: ordinary native rows clone a cached structure, adjacent removed rows are removed together, and stopped render effects release their ownership, so repeated create and clear cycles no longer retain DOM nodes.

## 1.0.0-alpha.30

- Build styles preserve `@import` and other statement at-rule semicolons when hoisted.

- HTMLKit can strip numeric file-route ordering prefixes without changing physical loader and import paths.
- HTMLKit exposes ordered concrete route navigation to applications and loaders, with an exported native navigation component.
- Installed and browser consumers exercise TypeScript controllers referenced with emitted `.js` module names.

## 1.0.0-alpha.29

### Added

- Svelte conversion for application and library output, including source-folder Vite imports, hydration, slots, and controller lifecycle behavior.
- Handler `$$event` references and the `event` payload type preserve native events, including when passed through another event's detail.
- `<dispatch target="ref">` sends native events to component-local refs. Collection refs receive one event per rendered element, with a shared payload evaluated once.

### Changed

- Controllers initialize once per component instance and use `host.on("connect", ...)` for setup and cleanup on each connection.
- Resource data lives under `host.data`; mutable and computed state live under `host.state`. Invalid and readonly writes warn and retain the accepted value.
- Prop styling uses `:host([prop])`; `:host-state()` selects mutable or computed state.
- Removed the unsupported `<method>` API and its generated element-method and checker bridges. Use reactive props and native events with controller listeners.

## 1.0.0-alpha.28

### Changed

- HTMLKit page and layout metadata now belongs inside its owning component carrier. File-level `htmlkit:page` selects the entry when a file declares multiple components. Helper metadata never contributes to a selected page or layout.
- HTML Next accepts and ignores safe direct carrier metadata, preserving one rendered root and excluding metadata from bindings, output, and component dependencies.

## 1.0.0-alpha.27

### Added

- Public `@nextwebwg/htmlkit` application platform with file and registered routes, static generation, Node loaders, development and preview commands, and HTML Next browser adoption.
- Default and named layouts in `app/layouts`, page layout overrides, and directory layout defaults using ordinary named slots.
- Page entry selection with `htmlkit:page` metadata and application-wide unique page names, independent of route URLs and browser bundle locations.
- Declarative title, meta, and link metadata with loader-prop bindings and page overrides. Regular HTML Next resource loaders accept and ignore inert metadata without changing the host document.
- A documentation consumer that exercises routing, Markdown content, generated component reference data, search, themes, and interactive examples; a concrete design for future request-time rendering.

### Fixed

- Components sharing a source file retain each component's stylesheet in HTMLKit browser builds.

## 1.0.0-alpha.26

### Fixed

- Inline row paths and `$value` now generate identical direct Vue text bindings, without an extra component per row. Loop aliases use inferred types for lowering rather than adding declared-reference guards.
- Mixed inline Vue text uses direct string concatenation instead of allocating a temporary array, preserving authored whitespace and empty values.
- Row `$value` expressions that return an invalid result retain the last valid text across keyed moves, matching inline expressions and the live runtime.

## 1.0.0-alpha.25

### Fixed

- Generated Vue components type nonempty scalar `concat()` calls as text, allowing strict consumer checks for ARIA attributes, IDs, slots, and child-component props. Invalid calls retain their sentinel type and runtime behavior.

## 1.0.0-alpha.24

### Added

- Reactive inline text expressions with single braces, including `{$user.name}`, across native, Vue, React, and server rendering.
- Intl formatting expressions with explicit formatters or declared-type inference, native options, and an optional locale; Node 22 server rendering includes duration formatting.
- Reproducible reactive benchmarks, pinned development-only comparison libraries, and a required performance regression check against main.

### Improved

- Repeated Intl formatting reuses bounded native formatter instances across updates and generated component instances.
- Identifier names exclude dollars, dashes, and escapes; references stay case-sensitive, and public prop names cannot differ only by ASCII casing.

## 1.0.0-alpha.23

### Added

- Publish HTML source folders directly, including nested components, and consume the same package with native, Vue, or React Vite plugins without a library build script.

- Source-only Vue and React library imports through the Vite adapter, with on-demand conversion, generated consumer declarations, and standalone type-sync support.
- Multiple component definitions in one HTML resource, each exposed as a distinct named export while unused components remain tree-shakeable.
- React 19.3 conversion for application and recursively discovered library component graphs. Generated TSX, plain CSS, controllers, and feature-specific helpers run without the HTML Next runtime.
- Distributable library output with typed React exports and dependency metadata, alongside native HTML Next and Vue entries.

### Improved

- Native Vite builds emit the generator’s scoped CSS, and Vue/React adapters leave Vite’s application HTML entry intact.

- React parity for props, state, computed values, events, context, slots, declared data, native form controls, safe HTML, structural templates, controllers, SSR, and hydration.
- Shared Vue and React generated sanitizer and data-URL logic, while keeping framework-specific rendering and control behavior separate.
- Three-browser behavior and pixel checks for the shared conformance corpus and feature-specific converter fixtures, including an installed nested-library consumer.

React applications continue to use React's native `onRecoverableError` handling for incompatible hydration roots; the converter does not replace that flow with an `HR005` wrapper.
