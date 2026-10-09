---
title: Moving between pages
order: 4
blurb: client navigation · prefetch · opt-outs
eyebrow: HTMLKit
---

# Moving between pages

Links between your pages are ordinary links:

```html
<a href="/guide/install/">Install</a>
```

Once the first page has loaded, clicking one doesn't reload the browser tab. HTMLKit fetches the
next page, keeps the layout both pages share, and swaps in the new page. There's nothing to set up.

## What stays and what changes

| Part of the page | When you move to another page |
| --- | --- |
| A layout both pages use | Stays, with its state and controller. An open menu stays open. |
| That layout's props | Update from its loader. `<hk-nav>` marks the new page current. |
| The page, and any layout only one page uses | Replaced. A fresh page starts from its loader's state. |
| `<title>`, description, and other head metadata | Update to the new page's. |
| Scroll position | Top of the page, or the `#fragment` in the link. Back and forward return to where you were. |
| Keyboard focus | Starts from the top, as after a page load. |

Screen readers hear the new page's title. Back, forward, and reload work as usual, and every URL
still loads directly.

## Links that load the whole page

These links load normally, as they would without HTMLKit:

| Link | Example |
| --- | --- |
| Another site | `<a href="https://example.com/">` |
| Outside the app's base path | `/elsewhere/` when the base is `/docs/` |
| A file rather than a page | `<a href="/report.pdf">` |
| A download, or a new tab or window | `download`, `target="_blank"`, or Ctrl, ⌘, Shift, or middle click |
| A `#fragment` on the same page | `<a href="#install">` |
| A form that posts | `<form method="post">` |
| Marked with `data-hk-reload` | `<a href="/print/" data-hk-reload>` |

Put `data-hk-reload` on a link, or on an element around several links, to load those pages in full:

```html
<nav data-hk-reload>
  <a href="/legacy/">Legacy reports</a>
  <a href="/admin/">Admin</a>
</nav>
```

If a page can't be shown in place, it loads in full instead. That happens when it's missing, when
the request fails, or when it defines a component differently from one already on the screen.

## Faster clicks

When the pointer rests on a link, or the link gets keyboard focus, HTMLKit starts fetching that
page. By the click, it's usually ready. Moving across a menu fetches nothing.

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

Client navigation needs the Navigation API: Chrome and Edge 102, Firefox 147, and Safari 26.2.
Older browsers and readers without JavaScript load every page in full, with the same result.

In `htmlkit dev`, styles from pages you've visited stay loaded until the next full reload. Built
sites remove a page's styles when you leave it.

Next: [Configuration and API](/htmlkit/configuration).
