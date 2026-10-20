---
title: Moving between pages
order: 6
blurb: client navigation · prefetch · opt-outs
eyebrow: HTMLKit
---

# Moving between pages

Links between your pages are ordinary links:

```html
<a href="/guide/install/">Install</a>
```

Once the first page has loaded, clicking one doesn't reload the browser tab. HTMLKit loads the
next page's code and a small file of its data, builds the page in the browser, keeps the layout both
pages share, and swaps in the new page. There's nothing to set up.

## What stays and what changes

| Part of the page | When you move to another page |
| --- | --- |
| A layout both pages use | Stays, with its state and module instance. An open menu stays open. |
| That layout's props | Update from its loader. `<hk-nav>` marks the new page current. |
| That layout's providers | A changed selected input adopts compatible prepared data without repeating the read. An existing read for the same input stays current. |
| The page, and any layout only one page uses | Replaced. A fresh page starts from its loader's state. |
| `<title>`, description, and other head declarations | Update to the new page's in one step, also inside a view transition. |
| Declared scripts | Stay loaded. A script the next page declares loads once; none runs twice. |
| Scroll position | Top of the page, or the `#fragment` in the link. Back and forward return to where you were. |
| Keyboard focus | Starts from the top, as after a page load. |

Screen readers hear the new page's title. Back, forward, and reload work as usual, and every URL
still loads directly.

Provider adoption keeps edited drafts and does not reconnect a retained layout. Its current browser
values, subscriptions, pending reads, and handled failures remain authoritative for the same selected
input, so returning to cached prerendered HTML does not replace newer live data. Change a selected
input or explicitly refresh when the data should be read again.

## Links that load the whole page

These links load normally, as they would without HTMLKit:

| Link | Example |
| --- | --- |
| Another site | `<a href="https://example.com/">` |
| Outside the app's base path | `/elsewhere/` when the base is `/docs/` |
| A file rather than a page | `<a href="/report.pdf">` |
| A download, or a new tab or window | `download`, `target="_blank"`, or Ctrl, ⌘, Shift, or middle click |
| A `#fragment` on the same page | `<a href="#install">` |
| Marked with `data-hk-reload` | `<a href="/print/" data-hk-reload>` |

Forms submit in place as well: a `GET` form loads its page with the form's query, and a
[form that posts](/htmlkit/forms#submitting-in-place) runs its page's action.

Put `data-hk-reload` on a link, or on an element around several links, to load those pages in full:

```html
<nav data-hk-reload>
  <a href="/legacy/">Legacy reports</a>
  <a href="/admin/">Admin</a>
</nav>
```

If a page's data file can't be used, HTMLKit fetches the page's HTML instead. If that can't be
shown in place either, the page loads in full. That happens when it's missing, when the request
fails, or when it defines a component differently from one already on the screen.

## Faster clicks

When the pointer rests on a link, the link gets keyboard focus, or a finger touches it, HTMLKit
starts loading that page's code and data. By the click, it's usually ready. Moving across a menu
fetches nothing. Links on screen only load code that several pages share, never a page's own
content, so a long sidebar stays cheap.

Choose a different policy for the whole site in `htmlkit.config.ts`:

```ts
export default defineConfig({ prefetch: 'visible' });
```

Or for one link, or every link inside an element:

```html
<a href="/big-report/" data-hk-prefetch="none">Big report</a>
<nav data-hk-prefetch="visible">…</nav>
```

| `prefetch` / `data-hk-prefetch` | Link on screen | Hover, focus, or touch |
| --- | --- | --- |
| `interaction` (default) | Shared code | The page's code and data |
| `visible` | The page's code and data | The page's code and data |
| `none` | Nothing | Nothing |

`visible` suits small sites. Prefetching never runs a page's code in the browser; it only downloads
it. For a page that [renders on each request](/htmlkit/loaders#rendering-on-each-request), loading its
data runs its loaders on the server, with the link's query and the reader's cookies, as loading the
page does. Give links to such pages `data-hk-prefetch="none"` when their loaders are costly.

## Animating the change

Add the rule browsers use for animated page loads, and HTMLKit animates client navigation with it
too:

```css
@media (prefers-reduced-motion: no-preference) {
  @view-transition { navigation: auto; }
}
```

The default is a cross-fade. Style `::view-transition-old(root)` and `::view-transition-new(root)`
to change it. Firefox loads pages without the animation.

## Showing that a page is loading

While a page loads in place, `<html>` has `data-hk-navigating`. While a
[form submits in place](/htmlkit/forms#submitting-in-place), the form also has
`data-hk-submitting` and `aria-busy="true"`. Both go when the next page has rendered, or when the
navigation fails or another replaces it. Show a pending indicator with CSS:

```css
.progress { opacity: 0; }
/* Shown after 150 ms, so a quick navigation shows nothing. */
:root[data-hk-navigating] .progress { opacity: 1; transition: opacity 200ms 150ms; }
form[data-hk-submitting] button { cursor: progress; opacity: 0.6; }
```

`aria-busy` tells screen readers the form is changing, and they hear the next page's title once it
renders, so an indicator needs no announcement of its own. Scripts read the browser's own state:
`navigation.transition` is set while a navigation is under way, and `navigatesuccess` and
`navigateerror` fire when it ends.

## Running code after a navigation

Controllers connect and disconnect with their components, so most code needs nothing else. For
code that watches the whole page, such as analytics, listen to the browser's own event:

```js
navigation.addEventListener('navigatesuccess', () => {
  track(location.pathname);
});
```

`hk:ready` fires once, when the first page has loaded.

## Browser support

Client navigation needs the Navigation API with `NavigateEvent.sourceElement`: Chrome and Edge 135,
Firefox 147, and Safari 26.2.
Older browsers and readers without JavaScript load every page in full, with the same result.

In `htmlkit dev`, styles from pages you've visited stay loaded until the next full reload. Built
sites remove a page's styles when you leave it.

Next: [Configuration and API](/htmlkit/configuration).
