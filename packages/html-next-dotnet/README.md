[![HTML Next](https://raw.githubusercontent.com/nextwebwg/html-next/main/assets/brand/html-next-lockup-nuget.png)](https://nextwebwg.org/html-next/dotnet)

# HTML Next for C#

Render HTML components from C# request data. Compile a template once and reuse it across requests. For interactive pages, matching JavaScript hydrates the output in the browser.

**[C# documentation →](https://nextwebwg.org/html-next/dotnet)**

## Start an ASP.NET application

Requires .NET 10.

```sh
dotnet new web -n HtmlNextDemo --framework net10.0
cd HtmlNextDemo
dotnet add package NextWebWG.HtmlNext --version 1.0.0-alpha.2
```

Replace `Program.cs`:

```csharp
using HtmlNext;

var app = WebApplication.CreateBuilder(args).Build();
var card = HtmlNextCompiler.Compile("""
    <template component="x-card">
      <defs><prop name="title" type="string" required>Card title.</prop></defs>
      <article><h1>{$title}</h1></article>
    </template>
    """, "card.html");

app.MapGet("/", (string? title, CancellationToken cancellationToken) =>
    Results.Content(card.Render(new { title = title ?? "Hello from C#" }, cancellationToken),
        "text/html; charset=utf-8"));
app.Run();
```

Run `dotnet run --urls http://localhost:5000`, then open `http://localhost:5000/?title=Welcome`.

## Continue with C#

- [Render files, bind request data and validate inputs](https://nextwebwg.org/html-next/dotnet).
- [Add JavaScript hydration and browser interaction](https://nextwebwg.org/html-next/dotnet-hydration).
- [Run the complete ASP.NET counter](https://github.com/nextwebwg/html-next/tree/main/packages/html-next-dotnet/examples/counter).
- [API reference and supported input](https://github.com/nextwebwg/html-next/blob/main/packages/html-next-dotnet/docs/api.md).

## Measured rendering

[![C# HTML Next rendering compared with Fluid, the .NET Liquid engine](https://raw.githubusercontent.com/nextwebwg/html-next/main/assets/performance/native-fluid-2026-11-10.svg)](https://nextwebwg.org/html-next/performance#csharp-rendering)

Five warm-template cases used 23% to 37% less rendering time than Fluid 2.41.1. [Method, data and limits](https://nextwebwg.org/html-next/performance#csharp-rendering).

[Source and issues](https://github.com/nextwebwg/html-next) · [MIT license](https://github.com/nextwebwg/html-next/blob/main/LICENSE)
