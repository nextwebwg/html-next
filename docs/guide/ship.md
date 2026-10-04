---
title: Ship a native library
order: 3
blurb: package your components · publish · install
eyebrow: HTML Next · Libraries
---

# Publish your HTML Next library

You have a collection of HTML Next components. Package those files together so other projects can install your library and use its component tags in their pages.

Your library keeps its own components, names, styles, and controllers. The packaging script below finds the HTML files in your `components/` folder and assembles them into an npm package.

## Does the directory layout matter?

The component format does not require a particular folder name. This packaging script uses `components/` as the source folder; change its glob if your library uses a different location.

```text title="Development project → published package"
Your development project              The package you publish
components/                            package/
  *.html                                 package.json
  subfolders/                            dist/
  controller modules                       index.js
scripts/build.mjs                          index.d.ts
package.json                             components/
README.md                                  HTML and controller files
LICENSE                                  html.manifest.json
                                         README.md
                                         LICENSE
```

Keep relative links between components working. Keep relative controller imports working too. The script includes all `.html` definitions under the source folder and copies the controllers they reference, including their relative JavaScript imports. Component filenames do not determine their public tags; those tags are declared in your HTML.

The separate `package/` directory contains the distributable library. Build tools and development files stay in your project.

## What belongs in package.json?

Your development project's manifest supplies the package metadata and build commands. Set these fields:

| Field | What you supply |
| --- | --- |
| `name` | The npm package name consumers will install. |
| `version` | Your library's release version. |
| `description` | A short description of the library. |
| `license` | The license matching your `LICENSE` file. |
| `type` | `"module"`, because the build script uses ES modules. |
| `dependencies` | External npm packages imported by your controllers, if any. |
| `devDependencies` | The HTML Next packaging tool, installed below. |
| `scripts` | The build, pack, and publish commands below. |

The build creates `package/package.json` for publication. It copies your metadata and controller dependencies, and adds these distribution fields:

| Generated field | Why it is needed |
| --- | --- |
| `exports` | Points a package import to the registration entry and its types. |
| `files` | Includes the generated entry, HTML definitions, controllers, and component inventory. |
| `sideEffects` | Preserves the registration import when consumers bundle their app. |
| `peerDependencies` | Declares the compatible HTML Next runtime version. |

The generated `sideEffects` field includes `"./dist/index.js"`; keep it, because importing that file registers the library. The generated runtime peer range matches the assembler version.

The development manifest's scripts and build tools are not copied into the published manifest. Consumers receive your library, not your build environment.

## Install the packaging tool

Use Node 22 or 24:

```bash
npm install --save-dev @nextwebwg/html-next
```

In your project's `package.json`, set your library's name, version, description, and license. Add these scripts:

```json title="package.json — build and release commands"
{
  "scripts": {
    "build": "node scripts/build.mjs",
    "pack:library": "npm run build && npm pack ./package",
    "publish:library": "npm run build && npm publish ./package --access public"
  }
}
```

Both release commands rebuild first. `pack:library` creates a tarball for testing; `publish:library` publishes the assembled package to npm.

## Assemble all your components

This script discovers every `.html` file under `components/`, including nested folders:

```js title="scripts/build.mjs"
import { copyFile, glob, readFile, rm, writeFile } from "node:fs/promises";
import { assembleComponentPackage } from "@nextwebwg/html-next";

const metadata = JSON.parse(await readFile("package.json", "utf8"));
const sources = (await Array.fromAsync(glob("components/**/*.html"))).sort();

await rm("package", { recursive: true, force: true });
await assembleComponentPackage({
  name: metadata.name,
  version: metadata.version,
  outDirectory: "package",
  components: sources.map((source) => ({ source })),
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./components/*": "./components/*",
  },
});

const path = "package/package.json";
const assembled = JSON.parse(await readFile(path, "utf8"));
const inventory = JSON.parse(await readFile("package/html.manifest.json", "utf8"));
await writeFile(path, `${JSON.stringify({
  ...assembled,
  description: metadata.description,
  license: metadata.license,
  dependencies: metadata.dependencies ?? {},
  files: ["dist", "components", "html.manifest.json",
    ...inventory.controllerModules.map((module) => module.path)],
}, null, 2)}\n`);
await copyFile("README.md", "package/README.md");
await copyFile("LICENSE", "package/LICENSE");
```

Declare any npm packages imported by your controllers in your project's `dependencies`. The script copies those declarations into the published package. Relative controller imports are copied automatically. Additional assets, such as images and data files, need their own copying and hosting setup; this script discovers component HTML and controller JavaScript.

Run `npm run build`. The published files have these roles:

| Published files | Purpose |
| --- | --- |
| `dist/index.js` | Registers your library's components when an app imports the package. |
| `dist/index.d.ts` | Types for the generated registration API. |
| `components/` | Your HTML definitions and the controller modules they reference. |
| `html.manifest.json` | A list of the packaged components and controller files. |
| `README.md` and `LICENSE` | Your library's documentation and license. |

The registration entry contains parsed component definitions, including their styles. Consumers do not need to fetch or parse those HTML files to render components, or import a separate library stylesheet. The package declares the HTML Next runtime as a peer dependency; consumers need that runtime to render and update the components.

## What should your README tell consumers?

Include four things: the installation command, the registration import, your public component tags and their API, and any asset-hosting requirements. Use your actual package name in these instructions.

Installation is:

```bash
npm install your-library @nextwebwg/html-next
```

In the consuming app's browser entry:

```js title="Application entry"
import "your-library";
```

That import registers the library and renders its component instances in the page. Consumers use the tags your library documents in their HTML. They do not need a component factory for every tag, a library build script, or the HTML Next Vite plugin. The consuming app can use its normal JavaScript bundler; the package import provides the registration setup.

`your-library` is a placeholder for your package name. The registration import runs in the browser; this guide covers browser distribution.

## Test the package, then publish

Run `npm run pack:library`. Install the resulting `.tgz` file and `@nextwebwg/html-next` in a separate app. Import the installed library and exercise the components your library exposes.

Check their behavior, styles, controllers, and any nested components. Also check the app's production build. Review the published file list with `npm pack ./package --dry-run`; it should contain your library's distributable files, README, and license.

When those checks pass, run `npm run publish:library`. After publication, consumers install your package by name using the same setup you tested with the tarball.

## Add Vue and React distribution

[Ship for Vue and React](/html-next/ship-frameworks) adds both framework builds to this same package. The native entry remains the default, while Vue and React apps get their own package imports.
