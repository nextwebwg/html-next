---
title: Ship for Vue and React
order: 4
blurb: one package · native, Vue, and React entries
eyebrow: HTML Next · Libraries
---

# One library. Native, Vue, and React.

Add Vue and React builds to the [native library](/html-next/ship). Publish all three in one package: `your-library` for native HTML Next, `your-library/vue` for Vue, and `your-library/react` for React. Your consumers install one library and use their application's framework.

Keep your existing `components/` folder as the source for every build. Every HTML component in that folder is included; you do not need to name each one in this script. The release scripts below convert both framework targets automatically, build their JavaScript and CSS, and generate their types before packing or publishing the library. Svelte packaging is coming soon.

## Install the additional build tools

Keep the packaging tool and script from the preceding guide, then install Vite and the framework build tools:

```bash
npm install --save-dev @nextwebwg/html-next-converter vite@^8 @vitejs/plugin-vue @vitejs/plugin-react vue@^3.5 react@^19.3 typescript@~5.9 vue-tsc @types/react@^19
```

Vue and React are development dependencies here because you need them to compile and check your library. The published package will declare them as optional peers, so a Vue app does not have to install React, or vice versa. The script also marks the native runtime as an optional peer: native consumers install it explicitly, while Vue and React consumers do not need it.

## Convert and bundle both targets

Create this script alongside `scripts/build.mjs`. It assembles the native library first, then converts every component for both frameworks. Each framework has its own output folder:

```js title="scripts/build-frameworks.mjs"
import { readFile, rm, writeFile } from "node:fs/promises";
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import react from "@vitejs/plugin-react";
import { convertComponents } from "@nextwebwg/html-next-converter";
import "./build.mjs";

await rm("generated", { recursive: true, force: true });
const manifest = JSON.parse(await readFile("package/package.json", "utf8"));

for (const target of ["vue", "react"]) {
  const conversion = await convertComponents({
    target,
    mode: "library",
    entries: ["components/**"],
    outDirectory: `generated/${target}-target`,
  });
  const dependencies = {
    ...manifest.dependencies,
    ...conversion.package.dependencies,
  };
  const peers = conversion.package.peerDependencies;
  manifest.dependencies = dependencies;
  manifest.peerDependencies = { ...manifest.peerDependencies, ...peers };
  manifest.peerDependenciesMeta = {
    ...manifest.peerDependenciesMeta,
    [target]: { optional: true },
  };

  await build({
    configFile: false,
    plugins: [target === "vue" ? vue() : react()],
    build: {
      outDir: `package/dist/${target}`,
      lib: {
        entry: `generated/${target}-target/${conversion.output.entry}`,
        formats: ["es"],
        fileName: "index",
        cssFileName: "style",
      },
      rolldownOptions: {
        external: (id) => Object.keys({ ...dependencies, ...peers })
          .some((name) => id === name || id.startsWith(`${name}/`)),
      },
    },
  });
}

Object.assign(manifest.exports, {
  "./vue": { types: "./dist/vue/index.d.ts", import: "./dist/vue/index.js" },
  "./vue/style.css": "./dist/vue/style.css",
  "./react": { types: "./dist/react/index.d.ts", import: "./dist/react/index.js" },
  "./react/style.css": "./dist/react/style.css",
});
manifest.peerDependenciesMeta["@nextwebwg/html-next"] = { optional: true };
await writeFile("package/package.json", `${JSON.stringify(manifest, null, 2)}\n`);
```

The converter writes `.vue` or `.tsx` files into `generated/`. Vite compiles those files into JavaScript and extracts their styles. Vue and React stay outside the bundles; the consuming app supplies its own framework. The assembled package keeps its native registration entry in `package/dist/`, with framework builds in `package/dist/vue/` and `package/dist/react/`.

The conversion result reports the packages its generated code imports. The script adds these to your manifest automatically. For example, a component using `$html` to render an HTML string needs `parse5` to handle that HTML consistently in the browser and on the server. The converter reports `parse5` as a dependency, so your consumers receive it when they install the library. Components without `$html` do not add that dependency.

If your own controller imports another package, declare that package in `dependencies` yourself. Review the manifest changes as part of each release. For component-relative `<data src>` URLs, set `publicRootURL` to the URL where those data files will be hosted; the converter does not publish those files for you.

## Generate public types

Vite builds JavaScript; run the framework typecheckers afterward to generate declaration files. Use TypeScript's [declaration-only output](https://www.typescriptlang.org/tsconfig/emitDeclarationOnly.html) with these configurations:

```json title="tsconfig.vue.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "allowJs": true,
    "allowImportingTsExtensions": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "rootDir": "generated/vue-target/vue",
    "outDir": "package/dist/vue"
  },
  "include": ["generated/vue-target/vue/**/*"]
}
```

```json title="tsconfig.react.json"
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
    "emitDeclarationOnly": true,
    "rootDir": "generated/react-target/react",
    "outDir": "package/dist/react"
  },
  "include": ["generated/react-target/react/**/*"]
}
```

## Expose all three entries

The native default export remains intact. The package now has three independent entry points:

| Consumer | Package import | What runs |
| --- | --- | --- |
| Native HTML Next app | `your-library` | The native registration entry, backed by the HTML Next runtime. |
| Vue app | `your-library/vue` | Compiled Vue components, backed by the app's Vue installation. |
| React app | `your-library/react` | Compiled React components, backed by the app's React installation. |

Each framework entry exports the components discovered in your HTML files. The converter derives the export names from your component tags; the tag's hyphenated name becomes a PascalCase export. Document those generated names in your library's README.

If your components have no styles, Vite may emit no framework stylesheet. Omit that target's CSS export and consumer import in that case.

## Automate packaging and publishing

Replace only the development project's `build` command. Keep `pack:library` and `publish:library` from the native guide:

```json title="package.json — complete build and release commands"
{
  "scripts": {
    "build": "node scripts/build-frameworks.mjs && vue-tsc -p tsconfig.vue.json && tsc -p tsconfig.react.json",
    "pack:library": "npm run build && npm pack ./package",
    "publish:library": "npm run build && npm publish ./package --access public"
  }
}
```

Each command builds your current HTML library into all three forms before packing or publishing. Only the assembled `package/` directory is published. Generated framework source stays in the development project's `generated/` directory; consumers receive JavaScript, declarations, and CSS.

This recipe bundles the whole library into one JavaScript entry and one stylesheet per framework. For larger libraries, use separate build entries and package exports per component if consumers need to avoid downloading unused component styles.

## Document framework consumption

In your README, tell Vue users to import their components from `your-library/vue`, and React users to import from `your-library/react`. They also import the matching `your-library/vue/style.css` or `your-library/react/style.css` stylesheet when your library has styles.

Consumers render those exports as normal Vue or React components. Neither framework entry needs the HTML Next Vite adapter. Native consumers retain the registration import and use the library's component tags in their HTML.

## Test all the published entries

Run `npm run pack:library` and install the tarball into separate native, Vue, and React apps. Exercise the public components your library actually ships, including their styles, controllers, nested components, and props. Run typechecks and production builds in the framework apps.

Check that the Vue entry works without React installed and that the React entry works without Vue installed. When all three consumer apps pass, publish the same package with `npm run publish:library`.

## Let applications convert instead

If you prefer to publish HTML source and have each consuming app convert it during its build, use [source library packaging](/html-next/convert#source-libraries). That approach requires the HTML Next Vite adapter in the consuming app. The compiled package above requires only the consumer's normal framework tools.
