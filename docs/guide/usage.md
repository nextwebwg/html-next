---
title: Usage
order: 1
navGroup: guide
blurb: HTML Next · Vue · React · Svelte
eyebrow: HTML Next · Usage
---

# Use HTML Next components

Choose a framework in any section. Every selector on this page follows your choice, so the setup and examples stay together.

## Install

Start with a Vite project and use Node 22.22.2+ or 24.15+. The plugin supports Vite 8.

```bash
npm install --save-dev @nextwebwg/html-next-unplugin
```

::: framework-html-next

The native build creates ordinary DOM elements.

:::

::: framework-vue

Keep your project's usual Vue plugin. The current target is Vue 3.5.

:::

::: framework-react

Keep your project's usual React plugin. The current target is React 19.3.

:::

::: framework-svelte

Keep your project's usual Svelte plugin. The current target is Svelte 5.57.1. The adapter uses the standard, unpatched framework; see the [known keyed-focus limitation](/html-next/convert).

:::

## Configure Vite {#vite}

::: framework-html-next

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ entries: ["src/app.html"] })],
});
```

:::

::: framework-vue

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "vue" }), vue()],
});
```

:::

::: framework-react

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "react" }), react()],
});
```

:::

::: framework-svelte

```ts title="vite.config.ts"
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ target: "svelte" }), svelte()],
});
```

:::

## Use your component

Build a small workshop check-in app: count guests as they arrive, then reset for the next session. Each example uses the same counter inside an `App` component and shows how to attach that app to the page. In an existing Vue, React, or Svelte project, keep its mounting code and add the counter to its `App` component.

::: framework-html-next

Save the [counter you built](/html-next/quick-start) as `src/counter.html`. Use it inside the app:

```html title="src/app.html"
<link rel="component" href="./counter.html">

<template component="x-app">
  <main>
    <h1>Workshop check-in</h1>
    <p>Count guests as they arrive. Reset for the next session.</p>
    <x-counter></x-counter>
  </main>
</template>
```

Attach the app to the page:

```js title="src/main.js"
import { createXApp } from "virtual:html-next/components";

document.getElementById("app").append(createXApp());
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Workshop check-in</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset. Vite builds the HTML definition into JavaScript that creates native DOM elements; a production build does not parse component definitions in the browser. Each component becomes a cloned template plus the exact DOM updates its features need, with the same behavior as the browser runtime. [How builds compile components](/html-next/performance#compiled-output) explains more.

:::

::: framework-vue

Save the [counter you built](/html-next/quick-start) as `src/counter.html`. Use it inside the app:

```html title="src/App.vue"
<script setup lang="ts">
import { XCounter } from "./counter.html";
</script>

<template>
  <main>
    <h1>Workshop check-in</h1>
    <p>Count guests as they arrive. Reset for the next session.</p>
    <XCounter />
  </main>
</template>
```

Attach `App` to the page:

```ts title="src/main.ts"
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Workshop check-in</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset.

The result uses Vue and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

:::

::: framework-react

Save the [counter you built](/html-next/quick-start) as `src/counter.html`. Use it inside the app:

```tsx title="src/App.tsx"
import { XCounter } from "./counter.html";

export default function App() {
  return (
    <main>
      <h1>Workshop check-in</h1>
      <p>Count guests as they arrive. Reset for the next session.</p>
      <XCounter />
    </main>
  );
}
```

Attach `App` to the page:

```tsx title="src/main.tsx"
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("app")!).render(<App />);
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Workshop check-in</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset.

The result uses React and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

:::

::: framework-svelte

Save the [counter you built](/html-next/quick-start) as `src/counter.html`. Use it inside the app:

```svelte title="src/App.svelte"
<script lang="ts">
  import { XCounter } from "./counter.html";
</script>

<main>
  <h1>Workshop check-in</h1>
  <p>Count guests as they arrive. Reset for the next session.</p>
  <XCounter />
</main>
```

Attach `App` to the page:

```ts title="src/main.ts"
import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app")! });
```

```html title="index.html"
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Workshop check-in</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Run your project's usual `npm run dev` command. Click the counter and Reset.

The result uses Svelte and native DOM roots. Generated components import the helpers their features need and have no HTML Next runtime dependency. Editing the HTML definition updates the component in your app.

:::

## Typecheck

::: framework-html-next

Run `html-next-check` to check components without building. It reports invalid declarations, constraints, and component links with their file and line. Pass the same entries as your Vite configuration:

```json title="package.json"
{
  "scripts": {
    "check": "html-next-check src/app.html"
  }
}
```

Check controllers and other application code with your project's usual tools, such as `tsc --noEmit`.

:::

::: framework-vue

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Check components with `html-next-check`, then generate declarations before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-check --target vue src/counter.html && html-next-sync && vue-tsc --noEmit"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "vue" })`.

:::

::: framework-react

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Check components with `html-next-check`, then generate declarations before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-check --target react src/counter.html && html-next-sync && tsc --noEmit"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "react" })`.

:::

::: framework-svelte

Enable `allowArbitraryExtensions` in your TypeScript configuration. The adapter writes adjacent `.d.html.ts` declarations for local imports. Check components with `html-next-check`, then generate declarations before a standalone typecheck:

```json title="package.json"
{
  "scripts": {
    "typecheck": "html-next-check --target svelte src/counter.html && html-next-sync && svelte-check"
  }
}
```

If a component needs declarations before its first import, add `entries: ["src/counter.html"]` to `htmlNext({ target: "svelte" })`.

:::

## Use a library {#use-a-library}

With the Vite plugin configured, install the library named in its README:

```bash
npm install your-library
```

::: framework-html-next

Add `htmlNext()` to your Vite plugins, using the same import shown above. Installed libraries are discovered automatically; you do not need to list their HTML files in `entries`.

Import the factory named in the library's README:

```js
import { createUiButton } from "your-library";

document.getElementById("app").append(createUiButton());
```

Here `your-library` and `createUiButton` are examples; use the package and component names your library documents.

:::

::: framework-vue

```js
import { UiButton } from "your-library";
```

Use those exports like other Vue components. The names come from the library's README. Include the generated `src/html-next.d.ts` in your TypeScript project to get its component types.

:::

::: framework-react

```js
import { UiButton } from "your-library";
```

Use those exports like other React components. The names come from the library's README. Include the generated `src/html-next.d.ts` in your TypeScript project to get its component types.

:::

::: framework-svelte

```js
import { UiButton } from "your-library";
```

Use those exports like other Svelte components. The names come from the library's README. Include the generated `src/html-next.d.ts` in your TypeScript project to get its component types.

:::

## Use it without a build step {#browser-runtime}

::: framework-html-next

Save the `app.html` and `counter.html` files from above beside this page. The module script loads the app and its counter, then renders the `<x-app>` instance:

```html title="index.html — browser runtime"
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Workshop check-in</title>
    <script type="module" src="https://cdn.jsdelivr.net/npm/@nextwebwg/html-next/dist/browser.js"></script>
    <link rel="component" href="./app.html">
  </head>
  <body><x-app></x-app></body>
</html>
```

Serve these files over HTTP. The runtime handles updates and components added to the page later. With a bundler, importing `@nextwebwg/html-next/browser` starts the same runtime.

### Browser support {#browser-support}

The live runtime needs native CSS `@scope`: Chrome 118, Safari 17.4, Firefox 146, or later. Vite output uses attribute-based style scoping for older browsers.

### Loading and trust

Same-origin component links work directly. Loading a component root from another origin requires an import-map entry, or a [`<meta name="component-src">`](#head) list that names its source. Controllers are ordinary trusted JavaScript; browser CORS and CSP rules apply. See the proposal's [resource loading rules](/declarative-components/security).

:::

::: framework-vue

For Vue, use the Vite adapter above. Choose HTML Next in this section for the direct browser-runtime setup.

:::

::: framework-react

For React, use the Vite adapter above. Choose HTML Next in this section for the direct browser-runtime setup.

:::

::: framework-svelte

For Svelte, use the Vite adapter above. Choose HTML Next in this section for the direct browser-runtime setup.

:::

## Contain a wrapped component's events {#contain-events}

A component that wraps another one sees the inner component's events bubble through its own root. To raise its own event in their place, its controller listens on its root in the capture phase and stops the inner event there:

```js title="src/picker.js"
export default function initialize(host) {
  host.on("connect", () => {
    const contain = (event) => {
      event.stopImmediatePropagation();
      host.dispatch("pick", event.detail);
    };
    host.root.addEventListener("select", contain, { capture: true });
    return () => host.root.removeEventListener("select", contain, { capture: true });
  });
}
```

The DOM runs capture listeners on an element before the event reaches a descendant, and before that element's own non-capture listeners when the element is the event's target, as it is for a component whose root is the wrapped component. So the consumer's non-capture `select` listeners on the root and above it never see the event, whenever they were added. A capture listener on an ancestor of the root still runs first, as does one the consumer added to the root before the controller connected. The pattern works the same in the browser runtime and in converted Vue, React, and Svelte components.

## Ask the consumer for behavior {#requests}

Some components need behavior from whoever uses them: an editor asks for mention suggestions, an image field asks where to store a file. The component declares a **request** in `<defs>`, a named question with a typed detail and a typed answer. Its controller asks with `host.request`, and the consumer answers in its own JavaScript. The [requests section of the proposal](https://nextwebwg.org/declarative-components/javascript#requests) defines the behavior.

```html title="src/editor.html"
<template component="ui-editor" controller="./editor.js">
  <defs>
    <request name="mention-query" type="object({ query: string })"
      returns="list(object({ id: string, label: string }))">
      People matching the text after @.
    </request>
  </defs>
  <div class="editor"></div>
</template>
```

A component that declares a request has `host.request(name, detail, { signal })`, which resolves to the answer, or to `null` when nobody answers. Each keystroke aborts the request before it, so a slow answer to `@ad` never replaces the answer to `@ada`:

```js title="src/editor.js"
export default function controller(host) {
  let pending;
  host.root.addEventListener("input", () => {
    pending?.abort();
    pending = new AbortController();
    host.request("mention-query", { query: currentQuery() }, { signal: pending.signal })
      .then((people) => showMentions(people ?? []), () => {}); // rejected: superseded or disconnected
  });
}
```

The answer is checked against `returns`, and a `null` answer is always accepted. The request travels as a `RequestEvent` that bubbles from the editor's root, and the nearest listener answers with `respondWith`:

::: framework-html-next

A consumer component answers in its controller:

```js title="src/notes.js"
export default function controller(host) {
  host.on("mention-query", (event) => {
    event.respondWith(searchPeople(event.detail.query, { signal: event.signal }));
  });
}
```

A page script answers with `respond()`, which takes a function that returns the answer:

```js title="src/setup.js"
import { respond } from "@nextwebwg/html-next";

respond(document, "mention-query", ({ query }, { signal }) => searchPeople(query, { signal }));
```

:::

::: framework-vue

Pass a function prop named after the request in camelCase, or listen with the event form:

```html title="src/App.vue"
<UiEditor :mention-query="({ query }, { signal }) => searchPeople(query, { signal })" />
<UiEditor @mention-query="(event) => event.respondWith(searchPeople(event.detail.query))" />
```

:::

::: framework-react

Pass a function prop named after the request in camelCase, or listen with the event form:

```tsx title="src/App.tsx"
<UiEditor mentionQuery={({ query }, { signal }) => searchPeople(query, { signal })} />
<UiEditor onMentionQuery={(event) => event.respondWith(searchPeople(event.detail.query))} />
```

:::

::: framework-svelte

Pass a function prop named after the request in camelCase, or listen with the event prop:

```svelte title="src/App.svelte"
<UiEditor mentionQuery={({ query }, { signal }) => searchPeople(query, { signal })} />
<UiEditor onmention-query={(event) => event.respondWith(searchPeople(event.detail.query))} />
```

:::

The component reads the function prop when each request arrives, so a new function takes effect on the next request. The generated types give the prop the request's detail and answer types. A framework prop and a request whose camelCase names match fail the build.

### Report progress

A long answer, such as an upload, reports progress while it is pending. The asker passes a `progress` callback, and the responder calls `event.progress(loaded, total)`:

```html title="src/image-field.html"
<template component="ui-image-field" controller="./image-field.js">
  <defs>
    <request name="image-upload" type="object">
      <prop name="file" type="unknown" required>The file the author dropped.</prop>
      <returns type="object"><prop name="src" type="string" required></prop></returns>
    </request>
  </defs>
  <figure><img $ref="preview" alt=""><progress $ref="bar" value="0"></progress></figure>
</template>
```

```js title="src/image-field.js"
export default function controller(host) {
  host.root.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    host.request("image-upload", { file }, {
      progress: (loaded, total) => { host.refs.bar.value = total === 0 ? 0 : loaded / total; },
    }).then((image) => { host.refs.preview.src = image?.src ?? URL.createObjectURL(file); });
  });
}
```

```js title="src/upload-setup.js"
import { respond } from "@nextwebwg/html-next";

respond(document, "image-upload", ({ file }, { signal, progress }) => uploadImage(file, {
  signal,
  onprogress: (loaded, total) => progress(loaded, total), // XMLHttpRequest upload progress
}));
```

With no uploader on the page, the request resolves `null` and the field keeps a local preview.

### Late responders

A request reaches the listeners that exist when it is asked. A request from inside a consumer component waits until that consumer's controller has run, so the two controllers load in either order. A page script that loads later, or a framework prop set after the component mounted, is a late responder: it announces itself, and each component whose request went unanswered receives a `responder` event and decides whether to ask again:

```js title="src/editor.js"
export default function controller(host) {
  const build = () => host.request("extensions").then((extensions) => createSession(extensions ?? []));
  build();
  host.on("responder", (event) => { if (event.detail.name === "extensions") build(); });
}
```

`respond()` announces its responder when it adds its listener. A page script that listens itself announces with a bubbling event:

```js
element.addEventListener("extensions", (event) => event.respondWith([Highlight]));
element.dispatchEvent(new CustomEvent("responder", { bubbles: true, detail: { name: "extensions" } }));
```

A consumer controller's later `host.on("extensions", …)`, and a function prop or event listener a framework sets after mounting, reach the waiting component the same way without dispatching an announcement.

## Add to the document head {#head}

A component declares what it adds to `document.head` in its `<defs>`: a `<title>`, `<meta>` entries, `<link>` resource hints and metadata links, and JSON-LD data blocks. While an instance is connected, the runtime adds them to the head; when it disconnects, they leave. The [head declarations section of the proposal](https://nextwebwg.org/declarative-components/components#head-declarations) defines the behavior.

```html title="src/pages/article.html"
<template component="page-article">
  <defs>
    <prop name="slug" type="string" required>The article's URL slug.</prop>
    <data name="article" src="/api/articles/{slug}"
          type="object({ title: string, summary: string, schema: object })">
      <param name="slug" from:value="$slug">
    </data>

    <title>{$article.value.title} · Field Notes</title>
    <meta name="description" from:content="$article.value.summary">
    <link rel="preconnect" href="https://images.example">
    <script type="application/ld+json" from:value="$article.value.schema"></script>
  </defs>

  <article><h1>{$article.value.title}</h1></article>
</template>
```

A `<title>` takes inline text expressions, a `<meta>` binds `from:content`, and a `<link>` binds `from:href`. A JSON-LD block holds literal JSON, copied unchanged, or binds its whole value with `from:value`: the runtime writes the object or list as JSON with every `<` escaped as `<`, so a value can never close the element, and a `null` value leaves the block out, as here while the article loads. A `<link>` uses `preconnect`, `dns-prefetch`, `preload`, `modulepreload`, `prefetch`, `canonical`, `alternate`, `icon`, `manifest`, `author`, `license`, `help`, `privacy-policy` or `terms-of-service`.

Every element the runtime manages carries `data-component-head`. When several connected components declare the same thing:

- **One title, one description.** A `<title>`, a canonical link, and each `<meta>` name or property go to the deepest component, and between two at the same depth, to the one that connected last. A page inside its layout sets the title over the layout's, and when the page leaves, the layout's title returns, in the same element.
- **Shared links and data.** Two cards that preconnect to the same host share one element, which stays until the last of them disconnects. JSON-LD blocks share one element per text.
- **Lists stay whole.** A component's repeated `<meta property="og:image">` entries are one list, and `og:image:width` and other sub-properties stay with the image their component declared. The deepest component's list replaces another's whole.
- **The page's own head returns.** A title or description the document itself has is set aside, unchanged, while a component replaces it, and put back as the same element afterwards. A link the document already has, such as its own preconnect, satisfies a component's declaration of it.

A page change, such as a router replacing one page with another inside the same layout, changes the head once: the title goes straight from one page's to the next, and links both pages declare stay in place. Inside a view transition, the change happens in the transition's update.

Some entries affect the whole page, its identity for search engines and sharing, and page-wide behavior: the canonical, `alternate`, `icon` and `manifest` links, the `robots`, `referrer`, `viewport`, `color-scheme`, `theme-color` and `component-src` metadata, and `og:url`. Only an application component sets these page-wide head entries: one in the application's own source, written in the page, or loaded by URL from the page's origin or a source the page lists in `component-src`, which takes a CSP source list:

```html title="index.html"
<meta name="component-src" content="'self' https://cdn.acme.example/ui/">
```

A component reached through a bare specifier, such as an installed package or an import-map entry, is an imported component, and so is everything it links. Its page-wide head entries are ignored with an `HL011` warning; its other head declarations apply.

A definition rejects `<meta http-equiv>`, `<meta charset>`, `<base>`, `<link rel="stylesheet">`, inline scripts and import maps, the `blocking` and `nonce` attributes, and event-handler attributes, with an `HC025` error. Invalid JSON-LD, or a block with both literal content and `from:value`, is `HC026`, and two titles or canonical links in one definition are `HC027`. Head declarations behave the same in the browser runtime, Vite output, and converted Vue, React and Svelte components, which share one head manager on the page.

### Load a third-party script {#declared-scripts}

A component that needs a third-party SDK declares its script in `<defs>`. The runtime inserts an ordinary `<script>` into `document.head`, once per URL and type, and never removes it, so the browser fetches and runs it once under the page's Content Security Policy, however many components declare it. The [declared scripts section of the proposal](https://nextwebwg.org/declarative-components/components#declared-scripts) defines the behavior.

```html title="src/checkout-form.html"
<template component="checkout-form" controller="./checkout-form.js">
  <defs>
    <prop name="pk" type="string" required>The Stripe publishable key.</prop>
    <event name="paymentready"></event>
    <handler name="announceReady"><dispatch event="paymentready"></dispatch></handler>

    <link rel="preconnect" href="https://js.stripe.com">
    <script name="stripe" src="https://js.stripe.com/v3/" loading="lazy" on:load="announceReady"></script>
  </defs>

  <form>
    <div $ref="card"></div>
    <p $if="$stripe.error" role="alert">Payments are unavailable right now.</p>
    <p $if="$stripe.pending">Loading the secure payment form…</p>
    <button>Pay</button>
  </form>
</template>
```

```js title="src/checkout-form.js"
export default function controller(host) {
  let card;
  host.on("connect", () => {
    host.scripts.stripe.ready.then(() => {
      if (!host.root.isConnected) return;
      card = Stripe(host.props.pk.value).elements().create("card");
      card.mount(host.refs.card);
    }, () => {});
  });
  host.on("disconnect", () => { card?.destroy(); card = undefined; });
}
```

- `loading="eager"`, the default, inserts the script when an instance connects; `lazy` when its root comes within 1,250 pixels of the viewport; `manual` when the controller calls `host.scripts.name.load()`.
- `$stripe.pending`, `.ok` and `.error` read the script's status, and `host.scripts.stripe` adds `ready`, a promise that settles once with the script, and `load()`.
- `on:load` and `on:error` run a handler once for each connection, as soon as the script settles: when it fires `load` or `error`, or straight away when it already has. A connection that ends first gets neither, and a reconnected form announces again.
- `type="module"`, `integrity`, `crossorigin`, `referrerpolicy` and `fetchpriority` are copied onto the inserted element. Declarations of one script that disagree on `integrity`, `crossorigin` or `referrerpolicy` fail with `HR011` for the later one. A bare `src`, such as `@acme/maps/v2.js`, resolves through the page's import map (`HR012` when it maps nothing).
- A `<script>` the page already has with the same URL is used instead of inserting another.
- A relative `src`, such as `./vendor/sdk.js`, is relative to the component's file. A Vite build serves and emits it as an asset; the converter resolves it against `publicRootURL`.
- Under a nonce-based policy, the runtime puts the nonce of the `<link rel="component">` or inline `<template component>` that imported the definition on the scripts it inserts. Under `'strict-dynamic'` or an origin allowlist such as `script-src 'self' https://js.stripe.com`, nothing more is needed.

Server rendering with `renderComponents(html, { definitions, head })` returns the page's `head` as well: the application's own head elements, the components' contributions reconciled into it, each replaced element in a `<template data-component-head="set-aside">`, and a `<link rel="preload" as="script">`, or `modulepreload`, for each eager script. It never writes an executing `<script>`. Hydration adopts those elements, restores the set-aside ones as the same nodes when no component sets them, and inserts each eager script once, served from its preload.

Converted components render the head on the server through their framework. Each target's `head` helper collects the head declarations the render reached, and `writeCollectedHead` writes them into a document holding the application's own head, with the same set-aside templates and preload links:

::: framework-vue

```ts title="server.ts"
import { renderToString } from "@vue/server-renderer";
import { createHeadCollector, HEAD_CONTEXT, writeCollectedHead } from "./generated/vue/head";

const collector = createHeadCollector();
const body = await renderToString(app, { [HEAD_CONTEXT]: collector });
writeCollectedHead(document, collector); // a server document, such as jsdom's, with the page's own <head>
```

:::

::: framework-react

```tsx title="server.tsx"
import { renderToString } from "react-dom/server";
import { collectHead, createHeadCollector, writeCollectedHead } from "./generated/react/head";

const collector = createHeadCollector();
const body = collectHead(collector, () => renderToString(<App />));
writeCollectedHead(document, collector); // a server document, such as jsdom's, with the page's own <head>
```

:::

::: framework-svelte

```ts title="server.ts"
import { render } from "svelte/server";
import { createHeadCollector, HEAD_CONTEXT, writeCollectedHead } from "./generated/svelte/head.svelte";

const collector = createHeadCollector();
const { body } = render(App, { context: new Map([[HEAD_CONTEXT, collector]]) });
writeCollectedHead(document, collector); // a server document, such as jsdom's, with the page's own <head>
```

:::

Serialize `document.head` into the page. The client hydrates as usual and adopts the head the server wrote.

## When you need more

- [Ship a library](/html-next/ship) when other projects need your components.
- Use the [CLI reference](https://github.com/nextwebwg/html-next#inspect-and-build-a-graph) to check definitions or build without Vite.
- See the [Vite plugin reference](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-unplugin) for libraries, externally defined custom elements, and build limits.
