using System.Net;
using System.Net.Sockets;
using System.Globalization;
using System.Text.Json;
using HtmlNext;

internal static class CatalogServer
{
    internal static async Task Run(string catalogFile)
    {
        using var catalog = JsonDocument.Parse(await File.ReadAllTextAsync(catalogFile));
        var root = catalog.RootElement;
        var assets = HtmlNextServerAssets.FromManifest(root.GetProperty("manifest").GetRawText());
        var sources = root.GetProperty("sources").EnumerateObject().ToDictionary(item => Path.GetFullPath(item.Name), item => item.Value.GetString()!);
        var graph = await HtmlNextCompiler.CompileAsync(sources.Keys, (specifier, referrer, _) =>
        {
            var id = Path.GetFullPath(referrer is null ? specifier : Path.Combine(Path.GetDirectoryName(referrer)!, specifier));
            return ValueTask.FromResult(new HtmlNextSource(id, sources[id]));
        }, assets: assets);
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        Console.WriteLine(JsonSerializer.Serialize(new { host = "127.0.0.1", port = ((IPEndPoint)listener.LocalEndpoint).Port, components = graph.Templates.Count }));
        try
        {
            while (true)
            {
                var client = await listener.AcceptTcpClientAsync();
                _ = Task.Run(() => Render(client, graph));
            }
        }
        finally { listener.Stop(); }
    }

    private static async Task Render(TcpClient client, CompiledComponentGraph graph)
    {
        using (client)
        {
            using var stream = client.GetStream();
            using var reader = new StreamReader(stream);
            using var writer = new StreamWriter(stream) { AutoFlush = true };
            try
            {
                var line = await reader.ReadLineAsync() ?? throw new InvalidOperationException("Missing application request.");
                using var request = JsonDocument.Parse(line);
                var root = request.RootElement;
                CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(root.GetProperty("locale").GetString()!);
                var template = graph.CompileApplication(root.GetProperty("source").GetString()!, "looma-browser-scene.html");
                var inputs = root.TryGetProperty("inputs", out var supplied) ? (object)supplied : null;
                var diagnostics = new List<HtmlNextDiagnostic>();
                var html = template.Render(inputs, onDiagnostic: diagnostics.Add, options: new() { Interactive = true });
                await writer.WriteLineAsync(JsonSerializer.Serialize(new { renderer = "dotnet", html, diagnostics }));
                Console.WriteLine(JsonSerializer.Serialize(new { rendered = template.Tag }));
            }
            catch (Exception error)
            {
                await writer.WriteLineAsync(JsonSerializer.Serialize(new { error = error.Message, code = (error as HtmlNextException)?.Code }));
            }
        }
    }
}
