using System.Collections.Frozen;
using System.Text.Json;

namespace HtmlNext;

public sealed record HtmlNextAssetSource(string Source, string Kind, string Sha256);

/// <summary>Immutable server metadata from a matching HTML Next build manifest.</summary>
public sealed class HtmlNextServerAssets
{
    private readonly FrozenDictionary<string, HtmlNextAssetSource> components;
    private readonly FrozenDictionary<string, IReadOnlyList<string>> stateNames;

    private HtmlNextServerAssets(HtmlNextAssetSource[] sources, Dictionary<string, HtmlNextAssetSource> components,
        Dictionary<string, IReadOnlyList<string>> stateNames, string[] stylesheets, bool hydrate, HtmlNextClientPlan? client)
    {
        Sources = Array.AsReadOnly(sources);
        this.components = components.ToFrozenDictionary(StringComparer.Ordinal);
        this.stateNames = stateNames.ToFrozenDictionary(StringComparer.Ordinal);
        Stylesheets = Array.AsReadOnly(stylesheets);
        Hydrate = hydrate;
        Client = client;
    }

    public IReadOnlyList<HtmlNextAssetSource> Sources { get; }
    /// <summary>Stylesheet filenames relative to the build output directory.</summary>
    public IReadOnlyList<string> Stylesheets { get; }
    public bool Hydrate { get; }
    public HtmlNextClientPlan? Client { get; }

    public static HtmlNextServerAssets FromManifest(string json, string sourceName = "<assets>")
    {
        ArgumentNullException.ThrowIfNull(json);
        try
        {
            using var document = JsonDocument.Parse(json);
            var server = document.RootElement.GetProperty("server");
            if (server.GetProperty("version").GetInt32() != 1) throw Error(sourceName, "Unsupported server asset version.");
            var sources = new List<HtmlNextAssetSource>();
            var bySource = new Dictionary<(string, string), HtmlNextAssetSource>();
            foreach (var item in server.GetProperty("sources").EnumerateArray())
            {
                var name = Text(item.GetProperty("source"));
                var kind = Text(item.GetProperty("kind"));
                var hash = Text(item.GetProperty("sha256"));
                if (kind is not ("component" or "stylesheet") || hash.Length != 64 || hash.Any(c => !char.IsAsciiHexDigit(c)))
                    throw Error(sourceName, "An asset source requires a known kind and SHA-256 fingerprint.");
                var source = new HtmlNextAssetSource(name, kind, hash.ToLowerInvariant());
                if (!bySource.TryAdd((name, kind), source)) throw Error(sourceName, $"Duplicate asset source '{name}'.");
                sources.Add(source);
            }
            var components = new Dictionary<string, HtmlNextAssetSource>(StringComparer.Ordinal);
            foreach (var item in document.RootElement.GetProperty("components").EnumerateArray())
            {
                var tag = Text(item.GetProperty("tag"));
                var name = Text(item.GetProperty("source"));
                if (!bySource.TryGetValue((name, "component"), out var source) || !components.TryAdd(tag, source))
                    throw Error(sourceName, $"Component '{tag}' has no unique source fingerprint.");
            }
            var states = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
            foreach (var item in server.GetProperty("stateNames").EnumerateObject())
                if (!states.TryAdd(item.Name, Array.AsReadOnly(Strings(item.Value)))) throw Error(sourceName, $"Duplicate state owner '{item.Name}'.");
            foreach (var tag in components.Keys)
                if (!states.ContainsKey(tag)) throw Error(sourceName, $"Component '{tag}' has no state requirements entry.");
            var stylesheets = Strings(server.GetProperty("stylesheets"));
            if (server.GetProperty("hasStyles").GetBoolean() && stylesheets.Length == 0)
                throw Error(sourceName, "The manifest requires stylesheets but contains no emitted stylesheet files.");
            var hydrate = server.TryGetProperty("hydrate", out var hydrating) && hydrating.GetBoolean();
            var client = document.RootElement.TryGetProperty("client", out var plan) ? HtmlNextClientPlan.Read(plan, components.Keys) : null;
            return new(sources.ToArray(), components, states, stylesheets, hydrate, client);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException or FormatException)
        {
            throw new HtmlNextException("HNCS006", "Invalid server asset manifest: " + error.Message, sourceName, error);
        }
    }

    internal static string Text(JsonElement value) => value.GetString() is { Length: > 0 } text ? text : throw new InvalidOperationException("Expected a nonempty string.");
    internal static string[] Strings(JsonElement value)
    {
        var result = value.EnumerateArray().Select(Text).ToArray();
        if (result.Distinct(StringComparer.Ordinal).Count() != result.Length) throw new InvalidOperationException("Duplicate asset metadata value.");
        return result;
    }

    internal IReadOnlyList<string> ForComponent(string tag, string hash, string sourceName)
    {
        if (!components.TryGetValue(tag, out var expected) || expected.Sha256 != hash)
            throw Error(sourceName, $"The source fingerprint for component '{tag}' does not match its built assets.");
        return stateNames[tag];
    }

    private static HtmlNextException Error(string source, string message) => new("HNCS006", message, source);
}
