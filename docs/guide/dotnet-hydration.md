---
title: C# browser hydration
order: 1.6
navGroup: dotnet
blurb: ASP.NET · built assets · interactive components
eyebrow: HTML Next · C#
---

# Keep a C# response interactive

Render a component with ASP.NET, then let matching JavaScript hydrate the rendered elements and handle browser interaction. The server supplies initial request data; the component keeps its state and computed dependencies when the browser takes over.

## Run the ASP.NET example

Requires .NET 10 and Node 24. Node builds the browser assets; ASP.NET serves the application.

```sh
git clone --depth 1 https://github.com/nextwebwg/html-next.git
cd html-next/packages/html-next-dotnet/examples/counter
dotnet restore
npm install
npm run build
dotnet run --urls http://localhost:5000
```

Open `http://localhost:5000/?start=12`. The initial response contains `Count: 12` and `Double: 24`, including when JavaScript is disabled. Click the button with JavaScript enabled: both become `Count: 13` and `Double: 26`.

The [example directory](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-dotnet/examples/counter) includes the project, component, browser module and build configuration.

## Compile once, render each request

The ASP.NET application reads the source and build manifest at startup. Each request supplies its initial count:

```csharp title="Program.cs"
using HtmlNext;

var app = WebApplication.CreateBuilder(args).Build();
var root = app.Environment.ContentRootPath;
var assets = HtmlNextServerAssets.FromManifest(await File.ReadAllTextAsync(
    Path.Combine(root, "wwwroot", "assets", "html-next.manifest.json")));
var graph = HtmlNextCompiler.CompileResource(
    await File.ReadAllTextAsync(Path.Combine(root, "counter.html")), "counter.html", assets: assets);
var counter = graph.Template("x-counter");

app.UseStaticFiles();
app.MapGet("/", (int? start, CancellationToken cancellationToken) =>
{
    var html = counter.Render(new { start = start ?? 5 }, cancellationToken,
        options: new HtmlNextRenderOptions { Interactive = true });
    return Results.Content($$"""
        <!doctype html>
        <html lang="en">
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HTML Next with C#</title></head>
        <body><main><h1>C# renders. JavaScript keeps it interactive.</h1>{{html}}</main><script type="module" src="/assets/app.js"></script></body>
        </html>
        """, "text/html; charset=utf-8");
});
app.Run();
```

`HtmlNextServerAssets.FromManifest` loads the matching client plan. `Interactive = true` includes the records the generated JavaScript needs to adopt the output. `UseStaticFiles` serves the built assets from `wwwroot`.

## Build the browser entry

The example's Vite configuration enables hydration and writes the browser files beside the ASP.NET static assets:

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

Its browser entry hydrates after the server markup is present:

```js title="main.js"
import { hydrate } from "virtual:html-next/hydrate";

hydrate();
```

The component declares its initial state and computed double in HTML. Its JavaScript module connects the button and changes the count. The [shared component example](/html-next/full-stack#the-shared-component) shows those files and the same component rendered by Node.

## Deploy source and assets together

Run `npm run build` before `dotnet publish -c Release`. The example project includes the component source and `wwwroot/assets` in the published application. Deploy that output together.

Source fingerprints must match the manifest. Rebuild the frontend assets after editing a component. For components with styles, include the graph's emitted stylesheets in the document head.

The current C# compiler supports the JavaScript module `connect` pattern used here. See [supported input](https://github.com/nextwebwg/html-next/blob/main/packages/html-next-dotnet/docs/api.md#implementation-status) for the current scope, including declarative handler limitations.

[Return to the C# quick start](/html-next/dotnet) or explore the [renderer API reference](https://github.com/nextwebwg/html-next/blob/main/packages/html-next-dotnet/docs/api.md).
