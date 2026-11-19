---
title: Full-stack Node and C#
order: 1.6
blurb: one component · two server hosts · browser interactivity
eyebrow: HTML Next · Full stack
navGroup: reference
---

# One component, Node or C# on the server

Render an HTML Next component with request data in Node or C#. The browser then hydrates the rendered elements and continues the component's state and computed dependencies.

The two runnable examples use identical HTML, JavaScript module, browser entry and Vite configuration. Both initially render `Count: 12` and `Double: 24`. Clicking the hydrated button changes them to `Count: 13` and `Double: 26`.

## The shared component

`start` comes from the server. `count` starts from that prop, and `doubled` depends on `count`:

```html title="counter.html"
<template component="x-counter" module="./counter.js">
  <defs>
    <prop name="start" type="number" default="0">Initial count supplied by the server.</prop>
    <state name="count" type="number" from="$start"></state>
    <computed name="doubled" from="$count * 2"></computed>
  </defs>
  <section>
    <button $ref="increment" type="button">Count: {$count}</button>
    <output>Double: {$doubled}</output>
  </section>
</template>
```

The browser module changes only the declared count. The dependency graph updates the button text and derived output:

```js title="counter.js"
export function connect(host) {
  return host.effect(() => {
    const button = host.refs.increment;
    const increment = () => { host.state.count += 1; };
    button.addEventListener("click", increment);
    return () => button.removeEventListener("click", increment);
  });
}
```

## Run the Node application

Requires Node 24. Get the examples:

```sh
git clone --depth 1 https://github.com/nextwebwg/html-next.git
cd html-next/packages/html-next/examples/full-stack-node
npm install
npm run build
npm start
```

Open `http://localhost:5001/?start=12` and click the button. Disable JavaScript and reload to inspect the initial HTML independently.

The server reads the component with `parseComponent` and calls the Node renderer:

```js
import { parseComponent } from "@nextwebwg/html-next";
import { renderComponents } from "@nextwebwg/html-next/server";

const definition = parseComponent(source, componentURL);
const { html } = await renderComponents("<x-counter></x-counter>", {
  definitions: [definition],
  props: { "x-counter": { start: 12 } },
});
```

Serve `html` in the application document and load the built browser entry. The [complete Node example](https://github.com/nextwebwg/html-next/tree/main/packages/html-next/examples/full-stack-node) includes its HTTP server and static asset delivery. The [Node rendering reference](https://github.com/nextwebwg/html-next/blob/main/packages/html-next/docs/server-rendering.md) covers stylesheets, preparation, cancellation and renderer lifetime.

## Run the C# application

Requires .NET 10 and Node 24. In another terminal, use the C# directory from the same checkout:

```sh
cd html-next/packages/html-next-dotnet/examples/counter
dotnet restore
npm install
npm run build
dotnet run --urls http://localhost:5000
```

Open `http://localhost:5000/?start=12`. C# produces the same count and computed value before JavaScript loads. The browser module then continues the same interaction.

The application installs `NextWebWG.HtmlNext` `1.0.0-alpha.2`. It loads the built manifest and compiles the component once at startup:

```csharp
var assets = HtmlNextServerAssets.FromManifest(
    await File.ReadAllTextAsync("wwwroot/assets/html-next.manifest.json"));
var graph = HtmlNextCompiler.CompileResource(
    await File.ReadAllTextAsync("counter.html"), "counter.html", assets: assets);
var counter = graph.Template("x-counter");

// Per request, using application-supplied data:
var html = counter.Render(new { start = 12 }, cancellationToken,
    options: new HtmlNextRenderOptions { Interactive = true });
```

The [complete ASP.NET example](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-dotnet/examples/counter) supplies `Program.cs`, the project file and static asset setup. [C# and .NET](/html-next/dotnet) starts with an installation and a minimal server response; the [API reference](https://github.com/nextwebwg/html-next/blob/main/packages/html-next-dotnet/docs/api.md) describes source graphs, validation and prepared data.

## Build and hydrate the browser side

Both examples use the same entry and Vite setup, with SDK packages `1.0.0-alpha.94`:

```js title="main.js"
import { hydrate } from "virtual:html-next/hydrate";

hydrate();
```

```js title="vite.config.js"
import { defineConfig } from "vite";
import htmlNext from "@nextwebwg/html-next-unplugin/vite";

export default defineConfig({
  plugins: [htmlNext({ entries: ["counter.html"], hydrate: true })],
  build: {
    outDir: "wwwroot/assets",
    emptyOutDir: true,
    lib: { entry: "main.js", formats: ["es"], fileName: () => "app.js" },
  },
});
```

Run the frontend build before starting either server. Deploy the matching component source and built assets together. The C# renderer checks the source fingerprint against the manifest; source edits require a new build. Include emitted stylesheets for components that use them.

The server owns request data and initial rendering. The generated browser factories adopt the initial elements, restore their state and connect the module. Browser modules own later events, refreshes and subscriptions. C# does not need a JavaScript engine to evaluate this component's declared initial dataflow.

The example uses the supported module `connect` hook for browser behavior. The current C# compiler's supported input excludes declarative `<handler>` bodies and `on:` attributes; see its [implementation status](https://github.com/nextwebwg/html-next/blob/main/packages/html-next-dotnet/docs/api.md#implementation-status).

## Why the graph travels between hosts

The component declares its prop, state seed, computed expression and text bindings in HTML. Those dependencies belong to the component language. A host can evaluate them using its own implementation, while the browser evaluates later changes from the same definition. The event module writes `count`; it does not repeat the computed formula or update either text node manually.

This is a benefit of a declared dependency language across implementation hosts. JavaScript module code keeps its own language and browser capabilities. Applications still supply host-specific request handling and data services. The [reactivity proposal](/declarative-components/reactivity) defines the dependency and availability semantics.

## Template rendering and hydration

[Fluid](https://github.com/sebastienros/fluid), the .NET Liquid engine, renders templates from data. Applications can add client behavior around that output. HTML Next supplies a matching generated component runtime and hydration records as part of its rendering workflow.

Liquid is also used outside server-only environments: [LiquidJS supports browser rendering](https://liquidjs.com/tutorials/setup.html#liquidjs-in-browsers). Other component frameworks support server rendering and hydration too, such as [React's `hydrateRoot`](https://react.dev/reference/react-dom/client/hydrateRoot). The examples here demonstrate HTML Next's shared component dataflow across Node, C# and the browser.

See [performance and size](/html-next/performance) for measured C# template rendering and JavaScript browser-update comparisons. Those are separate workloads and execution phases.
