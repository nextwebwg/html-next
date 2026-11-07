using System.Text.Json;
using HtmlNext;

using var request = JsonDocument.Parse(await File.ReadAllTextAsync(args[0]));
var root = request.RootElement;
var assets = HtmlNextServerAssets.FromManifest(root.GetProperty("manifest").GetRawText());
var graph = HtmlNextCompiler.CompileResource(root.GetProperty("source").GetString()!, assets: assets);
var inputs = root.TryGetProperty("inputs", out var supplied) ? (object)supplied : null;
Console.Write(graph.Template(root.GetProperty("tag").GetString()!).Render(inputs, options: new() { Interactive = true }));
