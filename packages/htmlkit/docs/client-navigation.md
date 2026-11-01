# Client navigation design

HTMLKit renders every page as a static document. After the first page hydrates, links to other
pages of the application render in place, as in Nuxt: HTMLKit loads the next page's module and its
data payload, renders its layers in the browser as the server does, keeps the layouts both pages
share, and swaps the rest. A page the payload cannot render loads from its static HTML
instead. This is tooling documentation; the component language is specified by the
[Declarative HTML Components proposal](https://nextwebwg.org/declarative-components/).

The owner's direction was Nuxt-like routing, with Next.js as a second reference, and then Nuxt-style
data payloads with the whole-HTML fetch as the fallback. Pages ship their components compiled to
direct DOM code (`generateComponent(…, { hydrate: true })`), not the live runtime. The implementation
is `src/client.ts` (shared by every page module), `browserSources` in `src/browser.ts`, `pagePayload`
in `src/document.ts`, and `@nextwebwg/html-next/generated-runtime` functions:
`adoptRenderedProps`, `replaceProjectedNode`, `generatedHost`, and `flushComponent`.

Each payload layer carries the loader's typed `props` alongside its HTML `attributes`. The typed
inputs retain explicit nulls and omit undefined values, so a declared default remains implicit
unless the loader supplied the prop. Fresh browser factories and retained layouts use this same
ownership. Attribute-only payloads remain readable. When JSON cannot carry props or state exactly,
navigation uses the server HTML and its component continuation records.

## Native audit

| Need | Native mechanism | Support, October 2026 |
| --- | --- | --- |
| Intercept same-document navigations of every kind (links, `location`, back and forward) | Navigation API: `navigate` event, `event.intercept()` | Chrome 102 (intercept 105), Firefox 147, Safari 26.2. Baseline since January 2026 |
| Skip what should stay native | `canIntercept` (other origins), `downloadRequest`, `destination.sameDocument` (fragments, `history.pushState`), `navigationType` | Same as above |
| Submit a form as the browser would: its action URL, `formaction`, method, encoding, and constraint validation | The `navigate` event's destination and `formData`, after validation; `sourceElement` is the submitter | Same as Navigation API |
| Focus after a submission | The intercept's focus reset, which focuses the autofocus delegate, else the body | Same as Navigation API |
| Pending state for scripts | `navigation.transition`, `navigatesuccess`, `navigateerror` | Same as Navigation API |
| Pending state for CSS | None: no pseudo-class matches a document or form during a navigation. HTMLKit sets `data-hk-navigating`, and `data-hk-submitting` with `aria-busy` on the form | |
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
| Adopt server DOM and connect modules | Compiled components bind server nodes in place; the document's one `MutationObserver` connects them | All |
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
- Chromium 153 and WebKit 26.6 treat the entries of a document that a load replaced, such as a page
  that loaded as a document for a conflicting definition, as the new document's own: traversing to one
  is a same-document `navigate` event (`destination.sameDocument`, `canIntercept`), and Firefox 155's
  is a cross-document one. HTMLKit intercepts such a traversal and renders the entry's page, in place
  or as a document. Before HTMLKit starts nothing intercepts it, so the URL changes and the loaded page
  stays; `navigation.activation.entry` is the entry the document loaded into, and when HTMLKit starts
  on another entry it renders that entry's page through the same navigation, as a `replace`.
- Firefox 155 fires a second `navigate` event, without `downloadRequest`, for a `download` link.
  HTMLKit also leaves alone any navigation whose `sourceElement` has `download`.
- Vite's development server rewrites a dynamic `import()` of a path to add `?import`, which is a
  second URL and so a second module instance. HTMLKit imports absolute URLs, which Vite leaves alone.

Not used:

- **History API fallback** (`pushState` and `popstate` with click interception). Every engine now
  ships the Navigation API, so older browsers keep document navigation, which is correct, only slower.
- **`precommitHandler`** would delay the URL change until the next page is ready, as Nuxt does. Safari
  26.2 lacks it, so the URL commits first and a failure loads the committed URL as a document.
- **Speculation Rules** prefetch only for document navigations and cannot feed `fetch`.

The browser does not announce a same-document navigation. As Nuxt (`<NuxtRouteAnnouncer>`) and
Next.js (`next-route-announcer`) do, HTMLKit adds a visually hidden `aria-live="polite"` region,
`#hk-announcer`, and puts the new title in it.

### The remaining gap

1. **One registry per document.** Page modules call `page()` in the shared `client.ts`, which
   registers each page's compiled components by tag, adopts the first page's server DOM, and starts
   navigation once. Pages that share a component share its compiled module, so a tag keeps one
   factory per document; a page that defines a tag differently throws when navigation imports its
   module, before anything renders, rather than re-render the current page's instances. Only a document of its own can hold
   that definition, so the page loads as one directly, without the HTML fallback, and logs nothing.
   A versioned documentation site whose archived pages define their own `<demo-counter>` takes this
   path between versions and stays in place within each.
2. **Which layers persist, and their new props.** Layers carry `data-hk-layer="N"`; older output's
   `hk-layer-N` IDs also remain readable. An authored `id` does not identify the layer. From the
   outermost, a layer whose root renders the same component (`component`) as the next page's
   layer at that depth persists. The page layer is always replaced, and so is everything below the
   first layer that differs. A persisted layer keeps its DOM, state, and module instance, but its loader
   may compute new props, such as `<hk-nav>`'s `current` item. `adoptRenderedProps(element, rendered)`
   reads the props of the layer's new rendering (a root its factory made, or a server root's
   continuation record) and applies them through the compiled prop channel, as the live runtime's
   function of that name does.
   Producer-owned inputs are omitted from that caller update. For provider-bearing layouts, the page
   registry lazily loads the existing binding adapter before the commit; the synchronous commit offers
   compatible values and read identities from the new renderer record through that adapter's input
   sources. A current attempt for the same selected input wins over a cached server baseline. No
   factory or connection restarts, local state stays intact, and dependent outputs use the existing
   native input/status tracking rather than a second value store.
   Components sharing that layout's root use their own tagged hosts and preparation. Between offers,
   `flushComponent` drains the existing component schedulers from outer owner to inner delegates,
   so forwarded inputs reflect retained browser state and the new caller props before selection.
3. **Replacing the page inside a kept layout.** The page is projected into its layout's `page` slot.
   HTML Next records projected nodes when it hydrates, so a plain `replaceWith` left the layout
   projecting the old page: the new page missed `data-slotted` (so the layout's `:slotted()` styles
   did not reach it), `host.slots` and the rendered form still listed the old page, and a slot that
   rendered again would bring the old page back. The parity tests found this.
   `replaceProjectedNode(current, next)` puts the new node in the old one's place in the projection
   too, as the live runtime's function of that name does.
4. **Head content.** HTML Next owns the head declarations, the elements marked
   `data-component-head`: the swap disconnects the old page and connects the new one, and its head
   manager reconciles them once, in the microtasks after the swap, which a view transition's update
   includes. HTMLKit diffs only its own unmarked links, stylesheets and an alias page's canonical
   link, with `isEqualNode`: shared ones stay, others are removed and added. Elements scripts add
   are left alone. New stylesheets load before the swap; component styles are scoped, so only the
   next page's global rules apply early.
5. **Route announcement** and **back and forward positions** in WebKit, above.
6. **Content Security Policy.** A policy belongs to its document, so client navigation keeps the
   current one, and HTMLKit gives every page of the site the same policy. The render document has no
   `<base>`, which `base-uri 'none'` forbids: the next page's module URLs resolve against its URL.

## Chosen approach: payloads, with the HTML as the fallback

The owner chose Nuxt-style payloads over fetching each page's HTML. A page's module already holds its
compiled components, including all of their static markup, so the HTML repeats what the module
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
  "head": { "lang": "en" },
  "styles": ["/kit/_htmlkit/page-3-….css"],
  "modules": ["/kit/_htmlkit/page-3-….js"],
  "layers": [
    { "component": "site-shell", "attributes": { "navigation": "[{\"href\":\"/kit/\",…}]" } },
    { "component": "install-page", "attributes": {}, "state": { "count": 4 } }
  ]
}
```

- `head` is what the page's document carries beyond its components: its language, and an alias
  page's `canonical` URL. The components' head declarations come from their compiled modules.
  `app/head.js` is not in it; it runs once per document load.
- `styles` and `modules` are what the page's document links.
- Each layer has its component, its invocation's prop attributes in their HTML form (defaults
  included, exactly as the server writes them), and its loader's state. Loader `data` stays private,
  as before; props and state were already public in the HTML.
- A page whose state JSON cannot carry exactly (`undefined`, `-0`, non-finite numbers, shared or
  non-plain objects) gets no payload and navigates by its HTML.

The build's `_htmlkit/manifest.json` also lists each page's shared chunks (`chunks`), for prefetching
links on screen.

### Rendering a payload

Pages with automatically prepared component providers use payload version 2: the server-rendered
body and component head accompany the layer metadata and assets. The browser parses that inert
markup and adopts it with the existing HTML Next continuation records. This preserves prepared
values, draft seeds and matching read identities when a fresh page is inserted. Version 1 remains
the factory path for pages without these providers:

1. Import the page's module, which registers its compiled components. A component that conflicts
   with one the document has throws here, before anything renders.
2. Make each layer with its component's factory, from the payload's invocation attributes as
   `application.ts` writes them (props by their attribute names, the rest as root attributes),
   innermost first, each page in its layout's `page` slot. Give each layer its loader's state
   through its host, then let the updates render. Nothing connects yet: a compiled root renders at
   construction and connects when it enters the document.
3. Swap as before: kept layouts take the new props through `adoptRenderedProps`, and the first
   changed layer replaces the old one through `replaceProjectedNode`. The new layers connect there,
   so named `connect` hooks start for their activation and browser reads resume. Server HTML from the fallback is adopted in
   place, as the first page was.

Every layer renders, kept layouts included: the kept layouts' new props come from their fresh
rendering, which is then discarded. A page reads its layout's context once it connects inside it.
The rendered markup matches the server's, attribute for attribute; a created root writes its
attributes in its own order, which the parity test sorts.

### Fallback to the HTML

The whole-HTML fetch from the first version of this design remains. HTMLKit uses it when the payload
is missing or fails, when the module fails to load, or when rendering throws. If the HTML cannot
render in place either (a missing page, a failed fetch, or a page without layers), or the page
defines a tag differently, the page loads as a document. Every opt-out is unchanged.

That document load is `navigation.navigate(url, { history: "replace" })`, which HTMLKit leaves
native: it takes the committed entry's place, so history has one entry for the visit, the page starts
at its top or fragment as any document load does, and back and forward cross between the documents
natively. `location.reload()` would keep the previous page's scroll position for the new one.

Alternatives considered:

| | Payload (chosen) | Static HTML (the fallback) |
| --- | --- | --- |
| Transfer per navigation, docs proof, gzip | 0.48 KB of data | 1.4 to 4.6 KB of HTML |
| New output | A payload per page, and a dev route | None |
| Next page's DOM | Rendered in the browser by its compiled components | Server markup |
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

JavaScript per page, gzip -9 of the page's module and every chunk it imports, from
`pnpm --filter @nextwebwg/htmlkit measure:delivery` on HTMLKit's examples. The live column is the
same pages delivered with the live runtime and serialized definitions, client navigation included:

| Page | Live runtime | Compiled |
| --- | ---: | ---: |
| basic `/` | 50,169 B | 19,322 B |
| basic `/items/one/` | 49,734 B | 18,966 B |
| docs proof `/` | 50,328 B | 23,473 B |
| docs proof `/guide/usage/` (largest) | 53,825 B | 26,740 B |
| docs proof `/reference/counter/` | 50,804 B | 24,307 B |

A page's module holds its components' compiled code, static markup included, and the
`generated-runtime` helpers they use; pages share the chunks of the components and helpers they
have in common.

A page whose components import shared stylesheets gets one stylesheet for its whole graph, named
for the graph; client navigation loads it like any other new stylesheet, and the browser tests
check it.

Transfer per navigation on the docs proof, gzip, measured with the live-runtime delivery. The page's module is needed either way, unless it is
already loaded:

| Page | Payload | HTML | Module |
| --- | --- | --- | --- |
| `/` | 478 B | 1,417 B | 1,143 B |
| `/guide/usage/` (largest) | 482 B | 4,614 B | 4,694 B |
| All 13 pages | 6.3 KB | 35.7 KB | 34.1 KB |

Navigation time on the docs proof between two guide pages that share a layout, measured with the
live-runtime delivery: the median of 20, on
`htmlkit preview` over loopback, with both modules already loaded. Client navigation is click to
`navigatesuccess`, which includes the fetch, styles, rendering, swap, and module connection.
Document navigation is the new document's navigation start to `DOMContentLoaded`, which excludes
unloading the old one. The HTML column forces the fallback, so it includes a failed payload request.
The machine was under heavy load; repeated runs varied by a few milliseconds.

| Engine | Payload | Payload, prefetched | HTML fallback | Document |
| --- | --- | --- | --- | --- |
| Chromium 153 | 4.6 ms | 3.4 ms | 4.8 ms | 23 ms |
| Firefox 155 | 9 ms | 5 ms | 7 ms | 24 ms |
| WebKit 26.6 | 8 ms | 6 ms | 7 ms | 26 ms |

Instrumented, rendering a payload with the live runtime (registering, lowering, settling,
serializing) took about 1 ms in each engine. Loopback hides network time, which is where the payload saves: about 2–4 KB less per
navigation here.

## Limits

- Development keeps component styles Vite injected for earlier pages; builds remove stylesheets the
  next page does not link.
- `app/head.js` runs once per document load.
- `GET` forms that submit to an application page render in place. `POST` forms submit with `fetch`,
  as the browser would send them, and render the answer from its HTML. A redirect's page renders from
  the same response, in a `replace` navigation to its URL, which aborts the submission's; that
  navigation reads the body first, since the abort ends it. A response that can't render in place
  reloads the submission's URL with `GET`, so a form is never sent twice.
- Links that component modules add after a navigation are not watched for visibility; they still prefetch
  on interaction.
