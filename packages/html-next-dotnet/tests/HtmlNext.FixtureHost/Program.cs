using System.Text.Json;
using HtmlNext;

if (args[0] == "--catalog-server")
{
    await CatalogServer.Run(args[1]);
    return;
}

using var request = JsonDocument.Parse(await File.ReadAllTextAsync(args[0]));
var root = request.RootElement;
var assets = HtmlNextServerAssets.FromManifest(root.GetProperty("manifest").GetRawText());
if (root.TryGetProperty("sources", out var resources))
{
    var sources = resources.EnumerateObject().ToDictionary(item => Path.GetFullPath(item.Name), item => item.Value.GetString()!);
    var results = new List<object>();
    foreach (var entry in root.GetProperty("entries").EnumerateArray())
    {
        var file = entry.GetString()!;
        try
        {
            var compiled = await HtmlNextCompiler.CompileAsync([file], (specifier, referrer, _) =>
            {
                var id = Path.GetFullPath(referrer is null ? specifier : Path.Combine(Path.GetDirectoryName(referrer)!, specifier));
                return ValueTask.FromResult(new HtmlNextSource(id, sources[id]));
            }, assets: assets);
            results.Add(new { file, pass = true, components = compiled.Templates.Keys });
        }
        catch (HtmlNextException error) { results.Add(new { file, pass = false, code = error.Code, source = error.SourceName, detail = error.Detail }); }
    }
    Console.Write(JsonSerializer.Serialize(results));
    return;
}
var graph = HtmlNextCompiler.CompileResource(root.GetProperty("source").GetString()!, assets: assets);
var inputs = root.TryGetProperty("inputs", out var supplied) ? (object)supplied : null;
HtmlNextPreparedModule? Prepare(HtmlNextPreparationContext context)
{
    if (!root.TryGetProperty("prepared", out var modules) || !modules.TryGetProperty(context.Module.Component, out var module)) return null;
    if (root.TryGetProperty("preparationReads", out var expected)) foreach (var item in expected.EnumerateObject())
        if (context.Read(item.Name).EncodeValue() != item.Value.GetString()) throw new InvalidOperationException($"Unexpected native preparation read: {item.Name}.");
    return new(module.GetProperty("source").GetString()!, module.GetProperty("reads").EnumerateObject().ToDictionary(item => item.Name,
        item => item.Value.TryGetProperty("inputKey", out var key)
            ? HtmlNextPreparedRead.FromTransfer(key.GetString()!, item.Value.GetProperty("value").GetString()!, context.CancellationToken)
            : new HtmlNextPreparedRead(item.Value.GetProperty("input"), item.Value.GetProperty("value"))));
}
var template = root.TryGetProperty("application", out var application)
    ? graph.CompileApplication(application.GetString()!) : graph.Template(root.GetProperty("tag").GetString()!);
Console.Write(template.Render(inputs, options: new()
{
    Interactive = true, PrepareModule = root.TryGetProperty("prepared", out _) ? Prepare : null
}));
