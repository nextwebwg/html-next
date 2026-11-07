using System.Text.Json;
using HtmlNext;

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
Console.Write(graph.Template(root.GetProperty("tag").GetString()!).Render(inputs, options: new() { Interactive = true }));
