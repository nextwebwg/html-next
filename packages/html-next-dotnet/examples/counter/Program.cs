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
