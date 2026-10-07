---
title: Publish a library
order: 3
blurb: publish your HTML · let apps choose their framework
eyebrow: HTML Next · Libraries
---

# Publish your HTML Next library

**Publish your `.html` files. Let the consuming app's Vite plugin build them.** This is the recommended way to share HTML Next components: one package works natively, in Vue, in React, and in Svelte.

You already have your components. Publishing them takes a package manifest, a README, and the usual npm commands.

## Point to your components

Keep your HTML files in a folder, with any controllers and other files they reference. Nested folders work too. This example calls the folder `components/`; use your existing folder name if you prefer.

```text
components/
  button.html
  dialog.html
  forms/
    input.html
package.json
README.md
LICENSE
```

Add these fields to your `package.json`, using your own name, version, and license:

```json title="package.json"
{
  "name": "your-library",
  "version": "1.0.0",
  "type": "module",
  "license": "MIT",
  "files": ["components"],
  "exports": {
    ".": { "html-next": "./components/" }
  }
}
```

`files` tells npm what to include. The `html-next` export tells the Vite plugin where your components live. The plugin finds the HTML files in that folder and its subfolders; you do not need an index file or a build script.

Keep relative component links and controller imports intact. If they reference another folder, include that folder in `files` too. Declare any npm packages imported by your controllers in `dependencies`, as you would for any library. npm includes your README and license automatically.

## Tell people how to use it

Your README should list the components and their props, explain what they do, and give consumers these instructions:

```bash
npm install your-library
npm install --save-dev @nextwebwg/html-next-unplugin
```

Add the HTML Next plugin to their Vite configuration using the [HTML Next](/html-next/usage#use-a-library), [Vue](/html-next/usage/vue), or [React](/html-next/usage/react) setup. Then import components from your package name.

For example, a definition named `ui-button` is exported as `UiButton` for Vue and React:

```js
import { UiButton } from "your-library";
```

Native HTML Next exports a function that creates its DOM:

```js
import { createUiButton } from "your-library";

document.getElementById("app").append(createUiButton());
```

Use your library's actual component names in the README. Consumers' usual Vite build handles the HTML, controllers, and component styles.

## Pack, try, publish

From your library's root:

```bash
npm pack --dry-run
npm pack
```

Review the file list, then install the resulting `.tgz` file in a separate app: `npm install ./path/to/your-library-1.0.0.tgz`. Follow your README and check the components, their styles, and the app's production build.

When it works, publish from the same directory:

```bash
npm publish --access public
```

## Need prebuilt Vue and React versions?

You can also [add prebuilt Vue and React entries](/html-next/ship-frameworks) for consumers who cannot use the Vite plugin. That guide covers both builds in one package. For most libraries, publishing the HTML and the plugin instructions above is simpler to maintain and lets each app choose its framework.
