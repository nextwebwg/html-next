# C# rendering with an interactive JavaScript counter

Requires .NET 10 and Node 24. Copy this directory to an application folder, then run:

```sh
dotnet restore
npm install
npm run build
dotnet run --urls http://localhost:5000
```

Open `http://localhost:5000/?start=12`. C# returns a button containing `Count: 12` in the initial HTML. The generated JavaScript hydrates that button and the module handles clicks, so its next value is `Count: 13`. Disable JavaScript and reload to see the initial server-rendered value independently.

The template also declares `doubled` as `$count * 2`. C# renders `Double: 24`; clicking the hydrated button updates it to `Double: 26` through the browser dependency graph. The module writes only `count`.

`counter.html` supplies the template, typed input and state seed for both runtimes. `counter.js` owns browser events and state changes. ASP.NET supplies request data, compiles the matching template and manifest once at startup, and reuses the template across requests.

Run the Vite build before starting ASP.NET, and rebuild after changing the HTML or JavaScript. Keep `counter.html` and all of `wwwroot/assets` together when deploying. The C# renderer checks the source fingerprint against the built manifest.

This example uses the supported JavaScript module `connect` hook for browser behavior. The .NET compiler currently accepts the initial-rendering declarations documented in the [renderer README](../../README.md); declarative `<handler>` bodies and `on:` attributes remain outside its supported input.

The [full-stack guide](https://nextwebwg.org/html-next/full-stack) covers both this application and the [Node example](../../../html-next/examples/full-stack-node), which uses identical frontend files. The [C# usage guide](https://nextwebwg.org/html-next/dotnet) explains the rendering API, stylesheets, component graphs and application-prepared data.
