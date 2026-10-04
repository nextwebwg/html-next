---
title: Prebuild Vue and React
order: 4
blurb: optional framework builds · one npm package
eyebrow: HTML Next · Libraries
---

# Add prebuilt Vue and React versions

**For most libraries, [publish the HTML](/html-next/ship) and give consumers the Vite-plugin instructions.** One source package serves every supported target, and you maintain fewer build tools and outputs.

Prebuilt versions are useful when consumers cannot add the HTML Next plugin. This guide adds `your-library/vue` and `your-library/react` to the same package. Consumers receive ordinary framework components; the original HTML remains available for apps using the plugin.

## Install the build tools

Start with the package from [Publish a library](/html-next/ship), then install:

```bash
npm install --save-dev @nextwebwg/html-next-converter vite@^8 @vitejs/plugin-vue @vitejs/plugin-react vue@^3.5 react@^19.3 typescript@~5.9 vue-tsc @types/react@^19
```

## Convert and build

Use one Vite configuration for both targets:

```js title="vite.config.mjs"
import { rm } from "node:fs/promises";
import { convertComponents } from "@nextwebwg/html-next-converter";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import react from "@vitejs/plugin-react";

export default defineConfig(async ({ mode }) => {
  if (!["vue", "react"].includes(mode)) throw new Error("Build with --mode vue or --mode react.");
  const generated = `generated/${mode}-target`;
  await rm(generated, { recursive: true, force: true });
  await convertComponents({ target: mode, mode: "library", entries: ["components/"], outDirectory: generated });
  return {
    plugins: [mode === "vue" ? vue() : react()],
    build: {
      outDir: `dist/${mode}`,
      lib: {
        entry: `generated/${mode}-target/${mode}/index.ts`,
        formats: ["es"],
        fileName: "index",
        cssFileName: "style",
      },
      rolldownOptions: {
        external: ["vue", "react", "react/jsx-runtime", "parse5"],
      },
    },
  };
});
```

These commands convert your components, then build their JavaScript and CSS:

```bash
npx vite build --mode vue
npx vite build --mode react
```

Vue and React stay outside the bundles; consumers use their own framework installation. Controllers are bundled with the components.

If a component renders HTML strings with `$html`, install `parse5` as a dependency of your library: `npm install parse5`. The generated `html-next.conversion.json` lists required dependencies. Declare your controllers' external dependencies as usual, and review that file when adding component features. If component-relative data URLs need a hosted location, set `publicRootURL` in the conversion options above.

## Include component types

Use a shared declaration configuration, then set each target's input and output folders:

```json title="tsconfig.library.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "allowJs": true,
    "allowImportingTsExtensions": true,
    "declaration": true,
    "emitDeclarationOnly": true
  }
}
```

```json title="tsconfig.vue.json"
{
  "extends": "./tsconfig.library.json",
  "compilerOptions": {
    "rootDir": "generated/vue-target/vue",
    "outDir": "dist/vue"
  },
  "include": ["generated/vue-target/vue/**/*"]
}
```

```json title="tsconfig.react.json"
{
  "extends": "./tsconfig.library.json",
  "compilerOptions": {
    "rootDir": "generated/react-target/react",
    "outDir": "dist/react"
  },
  "include": ["generated/react-target/react/**/*"]
}
```

Run `npx vue-tsc -p tsconfig.vue.json` and `npx tsc -p tsconfig.react.json` after the Vite builds.

## Expose both versions

Keep your package's name, version, license, and source export. Add `dist` to `files` and expose the framework builds:

```json title="package.json — distribution fields"
{
  "files": ["components", "dist"],
  "exports": {
    ".": { "html-next": "./components/" },
    "./vue": {
      "types": "./dist/vue/index.d.ts",
      "import": "./dist/vue/index.js"
    },
    "./vue/style.css": "./dist/vue/style.css",
    "./react": {
      "types": "./dist/react/index.d.ts",
      "import": "./dist/react/index.js"
    },
    "./react/style.css": "./dist/react/style.css"
  },
  "peerDependencies": { "vue": "^3.5.0", "react": "^19.3.0" },
  "peerDependenciesMeta": {
    "vue": { "optional": true },
    "react": { "optional": true }
  }
}
```

The optional peers let Vue consumers install Vue without React, and React consumers install React without Vue. If you already have other folders in `files` or other exports, keep them. If Vite emits no stylesheet for a target, omit that CSS export and its README import.

## Build before packing or publishing

Add these scripts to your existing manifest:

```json title="package.json — scripts"
{
  "scripts": {
    "build:vue": "vite build --mode vue && vue-tsc -p tsconfig.vue.json",
    "build:react": "vite build --mode react && tsc -p tsconfig.react.json",
    "prepack": "npm run build:vue && npm run build:react"
  }
}
```

`npm pack` and `npm publish` run `prepack` automatically. Publish from your project root, as in the source-library guide. The `generated` folder stays in your project; npm includes the HTML and finished `dist` outputs.

## Give consumers the matching imports

Show Vue users:

```js
import { UiButton } from "your-library/vue";
import "your-library/vue/style.css";
```

Show React users:

```js
import { UiButton } from "your-library/react";
import "your-library/react/style.css";
```

Use your actual component names. Consumers render these exports as normal Vue or React components, with no HTML Next plugin. Native consumers continue to use the HTML through the [native Vite setup](/html-next/usage#use-a-library).

Test the tarball in separate Vue and React apps, including their typechecks, production builds, styles, and behavior. This recipe produces one stylesheet per framework; importing it includes the whole library's styles. Publishing the HTML lets the consumer's plugin build component styles with the components it uses.
