using System.Collections.Frozen;
using System.Text.Json;

namespace HtmlNext;

public sealed record HtmlNextClientComponent(string Tag, IReadOnlyList<string> Dependencies, bool Adopt, bool Create, IReadOnlyList<string> Reasons);

/// <summary>The JavaScript compiler's immutable client selection. Native rendering does not repeat its analysis.</summary>
public sealed class HtmlNextClientPlan
{
    private readonly FrozenSet<string> adopted;
    private HtmlNextClientPlan(string module, string[] entries, string[] adoption, string[] creation, HtmlNextClientComponent[] components)
    {
        Module = module;
        Entries = Array.AsReadOnly(entries);
        Adoption = Array.AsReadOnly(adoption);
        Creation = Array.AsReadOnly(creation);
        Components = Array.AsReadOnly(components);
        adopted = adoption.ToFrozenSet(StringComparer.Ordinal);
    }

    public string Module { get; }
    public IReadOnlyList<string> Entries { get; }
    public IReadOnlyList<string> Adoption { get; }
    public IReadOnlyList<string> Creation { get; }
    public IReadOnlyList<HtmlNextClientComponent> Components { get; }
    internal bool Adopts(string tag) => adopted.Contains(tag);

    internal static HtmlNextClientPlan Read(JsonElement json, IEnumerable<string> tags)
    {
        if (json.GetProperty("version").GetInt32() != 1) throw new InvalidOperationException("Unsupported client plan version.");
        var module = HtmlNextServerAssets.Text(json.GetProperty("module"));
        if (module != "virtual:html-next/hydrate") throw new InvalidOperationException("Unknown client hydration module.");
        var known = tags.ToHashSet(StringComparer.Ordinal);
        string[] Tags(JsonElement value)
        {
            var names = HtmlNextServerAssets.Strings(value);
            if (names.Any(name => !known.Contains(name))) throw new InvalidOperationException("The client plan references an unknown component.");
            return names;
        }
        var entries = Tags(json.GetProperty("entries"));
        var adoption = Tags(json.GetProperty("adoption"));
        var creation = Tags(json.GetProperty("creation"));
        if (adoption.Except(creation, StringComparer.Ordinal).Any()) throw new InvalidOperationException("Adopted components require creation factories.");
        var components = new Dictionary<string, HtmlNextClientComponent>(StringComparer.Ordinal);
        foreach (var item in json.GetProperty("components").EnumerateArray())
        {
            var tag = HtmlNextServerAssets.Text(item.GetProperty("tag"));
            var adopt = item.GetProperty("adopt").GetBoolean();
            var create = item.GetProperty("create").GetBoolean();
            var component = new HtmlNextClientComponent(tag, Array.AsReadOnly(Tags(item.GetProperty("dependencies"))), adopt, create,
                Array.AsReadOnly(HtmlNextServerAssets.Strings(item.GetProperty("reasons"))));
            if (!known.Contains(tag) || !components.TryAdd(tag, component) || adopt != adoption.Contains(tag, StringComparer.Ordinal) || create != creation.Contains(tag, StringComparer.Ordinal))
                throw new InvalidOperationException("Inconsistent client component selection.");
        }
        if (components.Count != known.Count) throw new InvalidOperationException("Missing client component selection.");
        return new(module, entries, adoption, creation, components.Values.ToArray());
    }
}
