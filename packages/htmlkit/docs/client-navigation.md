# Client navigation design

HTMLKit renders every page as a static document. After the first page hydrates, links to other
pages of the application render in place: HTMLKit fetches the next page's static HTML, loads its
browser module, keeps the layouts both pages share, and swaps the rest. This is tooling
documentation; the component language is specified by the
[Declarative HTML Components proposal](https://nextwebwg.org/declarative-components/).

The owner's direction was Nuxt-like routing, with Next.js as a second reference. The
implementation is `src/client.ts` (shared by every page module) and HTML Next's
`adoptRenderedProps`.

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
| Fetch and parse the next page | `fetch`, `DOMParser` | All |
| Load the next page's components | dynamic `import()`; the module map shares one runtime instance | All |
| Adopt the new DOM and connect controllers | HTML Next's `observeDocument` (a `MutationObserver`) | All |
| Prefetch without running anything | `fetch` for the HTML; `<link rel="modulepreload">`, `<link rel="prefetch">` | modulepreload: all; prefetch: Chromium and Firefox |
| Animate the swap | `document.startViewTransition()`; the author's `@view-transition { navigation: auto }` | Chrome 111 and 126, Safari 18 and 18.2; Firefox 144 has only `startViewTransition` |

Playwright's Chromium 153, Firefox 155, and WebKit 26.6 support every row; the browser tests run on
all three. Two engine defects needed a line each:

- WebKit 26.6 sometimes restores no scroll position on back and forward after an intercepted
  navigation, through either `scroll: "after-transition"` or `event.scroll()` (in the tests, under
  `htmlkit dev`). HTMLKit uses `scroll: "manual"`, records each entry's position when it is left,
  and restores it after the swap; new entries still use `event.scroll()` for the top or fragment.
- Firefox 155 fires a second `navigate` event, without `downloadRequest`, for a `download` link.
  HTMLKit also leaves alone any navigation whose `sourceElement` has `download`.

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
   may compute new props, such as `<hk-nav>`'s `current` item. HTML Next had no way to carry a
   server rendering's props onto a live instance, so it gains `adoptRenderedProps(element, rendered)`,
   which reads the rendered root's continuation record and applies its props through the
   `updateComponentProps` channel, with its own regression test in each engine.
3. **Head metadata.** `meta` and `link` elements that came from server documents are diffed with
   `isEqualNode`: shared ones stay, others are removed and added. Elements scripts add are left alone.
   New stylesheets load before the swap; component styles are scoped, so only the next page's global
   rules apply early.
4. **Route announcement**, above.
5. **Back and forward positions** in WebKit, above.

## Chosen approach: fetch the static HTML

The client learns the next page from the HTML file a reader without JavaScript receives.

| | Static HTML (chosen) | Per-page payload, like Nuxt's `_payload.json` |
| --- | --- | --- |
| New build and dev output | None | A payload file per page and a dev endpoint |
| Rendering the next page | Server markup, adopted as on first load | Client rendering from definitions and props |
| Equal to a document load | By construction | Needs head, loader state, and render parity checks |
| Transfer per navigation (docs proof, gzip) | 1.4 to 4.6 KB of HTML | About 0.4 KB, with head and props |

The payload would save about 2.3 KB gzip per navigation, but it would add a second rendering path
whose output must match the server's, plus new artifacts. Next.js's flight payload has the same
trade-off with a more complex format. Swapping the whole body (Turbo) would lose layout state;
morphing (idiomorph) would diff every node where comparing layer tags is enough.

## Nuxt and Next.js

| | HTMLKit | Nuxt | Next.js (App Router) |
| --- | --- | --- | --- |
| Next page from | Static HTML | `_payload.json` and page chunks | RSC payload |
| Shared layouts | Kept; props updated in place | Kept | Kept, not re-rendered |
| Page with new params | Replaced | Replaced (keyed by path) | Replaced |
| Prefetch | On hover or focus after 80 ms | Visible links (default) or interaction | Visible links |
| Announcement | `aria-live="polite"` title | `aria-live="polite"` title | `aria-live="assertive"` title, `h1`, or path |
| Scroll and focus | Navigation API, with recorded back and forward positions | Router `scrollBehavior` | Router |
| Opt-out | `data-hk-reload` (on the link or an ancestor) | `external` | Plain `<a>` |
| Failure | Document load | Error page; a document load for a missing chunk | Document load |

Prefetching visible links would fetch every link of a large navigation (the docs proof has 14), and
a static HTML page is larger than a payload. HTMLKit prefetches on intent instead: a link that keeps
the pointer or focus for 80 ms. Sweeping across a menu fetches nothing. A prefetched page is used
once, within 30 seconds.

## Measurements

Bundle size, from a production build (`esbuild --minify` for the parts, Vite for the pages):

| | gzip |
| --- | --- |
| `client.ts`, bundled with the runtime | 1.9 KB |
| `adoptRenderedProps` in the runtime | 96 B |
| First page of the docs proof (page module and shared chunk) | 41.6 KB before, 44.0 KB after (+5.6%) |
| First page of the test fixture | 41.9 KB before, 44.3 KB after (+5.6%) |

Navigation cost on the docs proof between two guide pages that share a layout: the median of 20,
on `htmlkit preview` over loopback. Client navigation is click to `navigatesuccess`, which includes
the fetch, styles, module, swap, and controller connection. Document navigation is the new
document's navigation start to `DOMContentLoaded`, which excludes unloading the old one.

| Engine | Client | Client, prefetched | Document |
| --- | --- | --- | --- |
| Chromium 153 | 3.5 ms | 2.4 ms | 24 ms |
| Firefox 155 | 7 ms | 4 ms | 26 ms |
| WebKit 26.6 | 6 ms | 5 ms | 29 ms |

Loopback hides network time. A client navigation needs the HTML and, unless prefetched, the page's
module and stylesheet; a document navigation also requests every shared asset again.

## Limits

- A layout that renders `<slot name="page">` conditionally (inside `$if` or `$match`) would
  re-project the page it hydrated with. HTML Next records projected nodes when it hydrates; it has
  no API to replace them yet.
- Development keeps component styles Vite injected for earlier pages; builds remove stylesheets the
  next page does not link.
- `app/head.js` runs once per document load.
- `GET` forms that submit to an application page render in place; `POST` forms stay native.
