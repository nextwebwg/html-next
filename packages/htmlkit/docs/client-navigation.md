# Client navigation design

HTMLKit renders every page as a static document. After the first page hydrates, links to other
pages of the application render in place, as in Nuxt: HTMLKit loads the next page's module and its
data payload, renders its layers in the browser exactly as the server does, keeps the layouts both
pages share, and swaps the rest. A page the payload cannot render loads from its static HTML
instead. This is tooling documentation; the component language is specified by the
[Declarative HTML Components proposal](https://nextwebwg.org/declarative-components/).

The owner's direction was Nuxt-like routing, with Next.js as a second reference, and then Nuxt-style
data payloads with the whole-HTML fetch as the fallback. The implementation is `src/client.ts`
(shared by every page module), `pagePayload` in `src/document.ts`, and two HTML Next runtime
functions, `adoptRenderedProps` and `replaceProjectedNode`.

## Native audit

| Need | Native mechanism | Support, October 2026 |
| --- | --- | --- |
| Intercept same-document navigations of every kind (links, `location`, back and forward) | Navigation API: `navigate` event, `event.intercept()` | Chrome 102 (intercept 105), Firefox 147, Safari 26.2. Baseline since January 2026 |
| Skip what should stay native | `canIntercept` (other origins), `downloadRequest`, `formData`, `destination.sameDocument` (fragments, `history.pushState`), `navigationType` | Same as above |
| Per-link opt-out | `NavigateEvent.sourceElement` | Chrome 135, Firefox 147, Safari 26.2 |
| Modified clicks, `target`, middle clicks | They open another browsing context, so this document gets no `navigate` event | All |
| Cancel a superseded navigation | `event.signal` (an `AbortSignal`), passed to `fetch` | Same as Navigation API |
| URL, history entry, back and forward | `intercept()` commits the URL and entry | Same |
| Scroll to top or fragment; restore on back and forward | `intercept({ scroll })` and `event.scroll()` | Same |
| Focus as after a document load | `intercept({ focusReset: "after-transition" })` (default) | Same |
| A navigation finished | `navigation`'s `navigatesuccess` and `navigateerror` events | Same |
| Fetch the next page's data or HTML | `fetch`, `Response.json()`, `DOMParser` | All |
| Load the next page's components | dynamic `import()`; the module map shares one runtime instance | All |
| Render without running anything | An inert document from `document.implementation.createHTMLDocument()` | All |
| Adopt the new DOM and connect controllers | HTML Next's `observeDocument` (a `MutationObserver`) | All |
| Prefetch without running anything | `fetch` for data; `<link rel="modulepreload">` and `<link rel="prefetch">` for code and styles | modulepreload: all; prefetch: Chromium and Firefox |
| Links on screen, at idle | `IntersectionObserver`, `requestIdleCallback` (a timer where missing) | IntersectionObserver: all; requestIdleCallback: Chromium and Firefox |
| Touch intent | `touchstart` (passive) | All |
| Animate the swap | `document.startViewTransition()`; the author's `@view-transition { navigation: auto }` | Chrome 111 and 126, Safari 18 and 18.2; Firefox 144 has only `startViewTransition` |

Playwright's Chromium 153, Firefox 155, and WebKit 26.6 support every row; the browser tests run on
all three. Engine findings that needed code:

- WebKit 26.6 sometimes restores no scroll position on back and forward after an intercepted
  navigation, through either `scroll: "after-transition"` or `event.scroll()` (in the tests, under
  `htmlkit dev`). HTMLKit uses `scroll: "manual"`, records each entry's position when it is left,
  and restores it after the swap; new entries still use `event.scroll()` for the top or fragment.
- Firefox 155 fires a second `navigate` event, without `downloadRequest`, for a `download` link.
  HTMLKit also leaves alone any navigation whose `sourceElement` has `download`.
- Vite's development server rewrites a dynamic `import()` of a path to add `?import`, which is a
  second URL and so a second module instance. HTMLKit imports absolute URLs, which Vite leaves alone.

Not used:

- **History API fallback** (`pushState` and `popstate` with click interception). Every engine now
  ships the Navigation API, so older browsers keep document navigation, which is correct, only slower.
- **`precommitHandler`** would delay the URL change until the next page is ready, as Nuxt does. Safari
  26.2 lacks it, so the URL commits first and a failure reloads the committed URL.
- **Speculation Rules** prefetch only for document navigations and cannot feed `fetch`.

The browser does not announce a same-document navigation. As Nuxt (`<NuxtRouteAnnouncer>`) and
Next.js (`next-route-announcer`) do, HTMLKit adds a visually hidden `aria-live="polite"` region,
`#hk-announcer`, and puts the new title in it.

### The remaining gap

1. **One registry per document.** Each page module used to register its definitions and call
   `observeDocument`, which throws when called twice. Page modules now call `page()` in the shared
   `client.ts`, which registers each page's definitions and controllers and starts observation and
   navigation once. A tag keeps one definition per document: HTML Next accepts an identical
   redefinition and refuses a different one (`HR001`), which falls back to a document load.
2. **Which layers persist, and their new props.** Layers are the `hk-layer-N` roots. From the
   outermost, a layer whose root renders the same component (`data-component`) as the next page's
   layer at that depth persists. The page layer is always replaced, and so is everything below the
   first layer that differs. A persisted layer keeps its DOM, state, and controller, but its loader
   may compute new props, such as `<hk-nav>`'s `current` item. HTML Next gains
   `adoptRenderedProps(element, rendered)`, which reads a rendered root's continuation record and
   applies its props through the `updateComponentProps` channel.
3. **Replacing the page inside a kept layout.** The page is projected into its layout's `page` slot.
   HTML Next records projected nodes when it hydrates, so a plain `replaceWith` left the layout
   projecting the old page: the new page missed `data-slotted` (so the layout's `:slotted()` styles
   did not reach it), `host.slots` and the rendered form still listed the old page, and a slot that
   rendered again would bring the old page back. The parity tests found this. HTML Next gains
   `replaceProjectedNode(current, next)`, which puts the new node in the old one's place in the
   projection too, with a regression test in each engine.
4. **Head metadata.** `meta` and `link` elements that came from server documents are diffed with
   `isEqualNode`: shared ones stay, others are removed and added. Elements scripts add are left alone.
   New stylesheets load before the swap; component styles are scoped, so only the next page's global
   rules apply early.
5. **Route announcement** and **back and forward positions** in WebKit, above.

## Chosen approach: payloads, with the HTML as the fallback

The owner chose Nuxt-style payloads over fetching each page's HTML. A page's module already holds its
component definitions, including all of its static markup, so the HTML repeats what the module
carries. The payload carries only what the module cannot: the data.

### Payload format and location

`htmlkit build` writes one payload per page, and `application.fetch` (which `htmlkit dev` uses)
serves the same JSON per request through the same render as the document:

```text
/kit/guide/install/  →  /kit/_htmlkit/pages/guide/install/payload.json
/kit/                →  /kit/_htmlkit/pages/payload.json
```

`_htmlkit/` is reserved: a route segment and a public file may not use it, so a payload can never
collide with an application's own URLs. Within it, `pages/` mirrors the route path; route segments
cannot contain a dot, so `payload.json` never collides with a page's own directory.

```json
{
  "version": 1,
  "head": { "lang": "en", "title": "Install", "description": "…", "elements": [{ "tag": "meta", "attributes": { "charset": "utf-8" } }] },
  "styles": ["/kit/_htmlkit/page-3-….css"],
  "modules": ["/kit/_htmlkit/page-3-….js"],
  "layers": [
    { "component": "site-shell", "attributes": { "navigation": "[{\"href\":\"/kit/\",…}]" } },
    { "component": "install-page", "attributes": {}, "state": { "count": 4 } }
  ]
}
```

- `head` is the document head the server renders: language, title, description, and metadata
  elements. `app/head.js` is not in it; it runs once per document load.
- `styles` and `modules` are what the page's document links.
- Each layer has its component, its invocation's prop attributes in their HTML form (defaults
  included, exactly as the server writes them), and its loader's state. Loader `data` stays private,
  as before; props and state were already public in the HTML.
- A page whose state JSON cannot carry exactly (`undefined`, `-0`, non-finite numbers, shared or
  non-plain objects) gets no payload and navigates by its HTML.

The build's `_htmlkit/manifest.json` also lists each page's shared chunks (`chunks`), for prefetching
links on screen.

### Rendering a payload

1. Import the page's module, which registers its definitions and controllers. A conflicting
   definition throws here, before anything renders.
2. In an inert document, build the layers' invocations from the payload, as `application.ts` builds
   them; lower them with HTML Next without connecting anything; give each layer its state; let
   structural updates settle and lower again; serialize with `serializeRenderedForm`. These are the
   steps of HTML Next's server worker, run by the same runtime.
3. Swap as before: kept layouts take the new props through `adoptRenderedProps`, the first changed
   layer replaces the old one through `replaceProjectedNode`, and HTML Next adopts the new DOM as it
   adopts server HTML, so controllers connect once and declared reads start.

Every layer renders, kept layouts included: a page may read its layouts' context, and the kept
layouts' new props come from their fresh rendering. Rendering live in place, without serializing,
would save the serializer (1.2 KB gzip) and a parse, but HTML Next has no way to give an un-lowered
invocation its initial state before its controller connects; the serialized form is the existing,
tested server-to-browser contract.

### Fallback to the HTML

The whole-HTML fetch from the first version of this design remains. HTMLKit uses it when the payload
is missing or fails, when the module fails to load, or when rendering throws. If the HTML cannot
render in place either (a missing page, a failed fetch, a page without layers, or a conflicting
definition), the page loads as a document. Every opt-out is unchanged.

Alternatives considered:

| | Payload (chosen) | Static HTML (the fallback) |
| --- | --- | --- |
| Transfer per navigation, docs proof, gzip | 0.48 KB of data | 1.4 to 4.6 KB of HTML |
| New output | A payload per page, and a dev route | None |
| Next page's DOM | Rendered in the browser by the server's steps | Server markup |
| Same result as a document load | Proven by parity tests in each engine and mode | By construction |

Swapping the whole body (Turbo) would lose layout state; morphing (idiomorph) would diff every node
where comparing layer tags is enough.

## Prefetching

Prefetching never runs anything: payloads are data, and modules and stylesheets are only hinted with
`modulepreload` and `prefetch`. The policy is the site's `prefetch` option, overridden by
`data-hk-prefetch` on a link or an ancestor:

| Policy | Link on screen, at idle | Hover or focus for 80 ms, or touch |
| --- | --- | --- |
| `interaction` (default) | The page's shared chunks only, from the build manifest | Payload and module |
| `visible` | Payload and module | Payload and module |
| `none` | Nothing | Nothing |

A page's own module holds its content, so the default never downloads it for links on screen: a
100-link documentation sidebar would otherwise download every page. Sweeping across a menu fetches
nothing; each page is fetched once and a prefetched payload is used within 30 seconds. Development
has no build manifest, so links on screen prefetch nothing there by default.

A future request-time server adapter must not prefetch payloads for links on screen: each payload
request would run that page's loaders.

## Nuxt and Next.js

| | HTMLKit | Nuxt | Next.js (App Router) |
| --- | --- | --- | --- |
| Next page from | Page module and `_htmlkit/pages/…/payload.json`; HTML as the fallback | Page chunks and `_payload.json` | RSC payload |
| Shared layouts | Kept; props updated in place | Kept | Kept, not re-rendered |
| Page with new params | Replaced | Replaced (keyed by path) | Replaced |
| Prefetch | Shared code for links on screen; page data and module on interaction | Visible links (default) or interaction | Visible links |
| Announcement | `aria-live="polite"` title | `aria-live="polite"` title | `aria-live="assertive"` title, `h1`, or path |
| Scroll and focus | Navigation API, with recorded back and forward positions | Router `scrollBehavior` | Router |
| Opt-out | `data-hk-reload` (on the link or an ancestor) | `external` | Plain `<a>` |
| Failure | The HTML, then a document load | Error page; a document load for a missing chunk | Document load |

## Measurements

Bundle size, from a production build (`esbuild --minify` for the parts, Vite for the pages):

| | gzip |
| --- | --- |
| `client.ts`, bundled with the runtime | 2.9 KB |
| `serializeRenderedForm` in the runtime | 1.2 KB |
| `adoptRenderedProps`, `lowerDocument`, `replaceProjectedNode` in the runtime | 96 B, 71 B, 68 B |
| First page of the docs proof (page module and shared chunks) | 41.6 KB without client navigation, 44.0 KB with the HTML design, 46.1 KB now (+10.8%) |
| First page of the test fixture | 41.9 KB, 44.3 KB, 46.4 KB (+10.8%) |

These were measured before #193's shared stylesheets enlarged the runtime. On that base, the client
and its runtime functions add 4.4 KB gzip to a 43.1 KB runtime (+10.2%).

A page whose components import shared stylesheets gets one stylesheet for its whole graph, named
for the graph; client navigation loads it like any other new stylesheet, and the browser tests
check it.

Transfer per navigation on the docs proof, gzip. The page's module is needed either way, unless it is
already loaded:

| Page | Payload | HTML | Module |
| --- | --- | --- | --- |
| `/` | 478 B | 1,417 B | 1,143 B |
| `/guide/usage/` (largest) | 482 B | 4,614 B | 4,694 B |
| All 13 pages | 6.3 KB | 35.7 KB | 34.1 KB |

Navigation time on the docs proof between two guide pages that share a layout: the median of 20, on
`htmlkit preview` over loopback, with both modules already loaded. Client navigation is click to
`navigatesuccess`, which includes the fetch, styles, rendering, swap, and controller connection.
Document navigation is the new document's navigation start to `DOMContentLoaded`, which excludes
unloading the old one. The HTML column forces the fallback, so it includes a failed payload request.
The machine was under heavy load; repeated runs varied by a few milliseconds.

| Engine | Payload | Payload, prefetched | HTML fallback | Document |
| --- | --- | --- | --- | --- |
| Chromium 153 | 4.6 ms | 3.4 ms | 4.8 ms | 23 ms |
| Firefox 155 | 9 ms | 5 ms | 7 ms | 24 ms |
| WebKit 26.6 | 8 ms | 6 ms | 7 ms | 26 ms |

Instrumented, rendering a payload (registering, lowering, settling, serializing) took about 1 ms in
each engine. Loopback hides network time, which is where the payload saves: about 2–4 KB less per
navigation here.

## Limits

- Development keeps component styles Vite injected for earlier pages; builds remove stylesheets the
  next page does not link.
- `app/head.js` runs once per document load.
- `GET` forms that submit to an application page render in place; `POST` forms stay native.
- Links that controllers add after a navigation are not watched for visibility; they still prefetch
  on interaction.
