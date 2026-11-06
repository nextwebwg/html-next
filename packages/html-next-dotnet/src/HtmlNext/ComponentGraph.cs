using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text;
using AngleSharp.Dom;
using AngleSharp.Html.Dom;
using AngleSharp.Html.Parser;

namespace HtmlNext;

/// <summary>Application-resolved source. Id is its canonical identity; Revision is application-owned.</summary>
public sealed record HtmlNextSource(string Id, string Content, string? Revision = null);

/// <summary>Resolves an authored reference relative to its importing source, or an application entry.</summary>
public delegate ValueTask<HtmlNextSource> HtmlNextSourceResolver(string specifier, string? referrer, CancellationToken cancellationToken);

public sealed record HtmlNextModuleReference(string Component, string SourceId, string Specifier);

public sealed record CompiledSource(string Id, string? Revision, string Sha256, IReadOnlyList<string> Dependencies);

/// <summary>An immutable compiled source graph. Retain its templates across requests.</summary>
public sealed class CompiledComponentGraph
{
    internal CompiledComponentGraph(Dictionary<string, CompiledTemplate> templates, CompiledSource[] sources, HtmlNextServerAssets? assets)
    {
        Templates = templates.ToFrozenDictionary(StringComparer.Ordinal);
        Sources = Array.AsReadOnly(sources);
        Stylesheets = assets?.Stylesheets ?? Array.Empty<string>();
        Modules = Array.AsReadOnly(templates.Values.Select(template => template.Module).OfType<HtmlNextModuleReference>().OrderBy(module => module.Component, StringComparer.Ordinal).ToArray());
    }

    public IReadOnlyDictionary<string, CompiledTemplate> Templates { get; }
    public IReadOnlyList<CompiledSource> Sources { get; }
    public IReadOnlyList<string> Stylesheets { get; }
    public IReadOnlyList<HtmlNextModuleReference> Modules { get; }
    public CompiledTemplate Template(string tag) => Templates.TryGetValue(tag, out var template) ? template
        : throw new KeyNotFoundException($"No component '{tag}' is defined in this graph.");
}

internal sealed class ComponentReference
{
    internal static readonly IReadOnlyDictionary<string, ScopedSlotContract> EmptySlots = new Dictionary<string, ScopedSlotContract>();
    public IReadOnlyDictionary<string, ScopedSlotContract> Slots { get; set; } = EmptySlots;
    public Prop[] Props { get; set; } = [];
    public string? DelegatedTag { get; init; }
    public bool ReceivesAttributes { get; set; }
    public CompiledTemplate Template { get; set; } = null!;
}

public static partial class HtmlNextCompiler
{
    /// <summary>Compiles all carriers in one resource without resolving external dependencies.</summary>
    public static CompiledComponentGraph CompileResource(string source, string sourceName = "<source>", HtmlNextServerAssets? assets = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        using var resource = ReadResource(new(sourceName, source));
        if (resource.References.Length != 0) throw ValueType.Error(sourceName, "Component dependency links require CompileAsync and an application resolver.");
        return Link([resource], default, assets);
    }

    /// <summary>Loads and compiles the complete declared graph. Rendering never calls the resolver.</summary>
    public static async ValueTask<CompiledComponentGraph> CompileAsync(IEnumerable<string> entries, HtmlNextSourceResolver resolver, CancellationToken cancellationToken = default, HtmlNextServerAssets? assets = null)
    {
        ArgumentNullException.ThrowIfNull(entries);
        ArgumentNullException.ThrowIfNull(resolver);
        var resources = new Dictionary<string, SourceResource>(StringComparer.Ordinal);
        var requests = new Dictionary<(string? Referrer, string Specifier), string>();
        try
        {
            foreach (var entry in entries) await Load(entry, null).ConfigureAwait(false);
            if (resources.Count == 0) throw ValueType.Error("<entries>", "At least one component source entry is required.");
            cancellationToken.ThrowIfCancellationRequested();
            return Link(resources.Values, cancellationToken, assets);
        }
        finally { foreach (var resource in resources.Values) resource.Dispose(); }

        async ValueTask<string> Load(string specifier, string? referrer)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ExecutionStack.Check(referrer ?? specifier);
            if (string.IsNullOrWhiteSpace(specifier)) throw ValueType.Error(referrer ?? "<entries>", "A source reference cannot be empty.");
            if (requests.TryGetValue((referrer, specifier), out var known)) return known;
            HtmlNextSource resolved;
            try { resolved = await resolver(specifier, referrer, cancellationToken).ConfigureAwait(false); }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                throw new HtmlNextException("HNCS005", $"Resolving component source '{specifier}' failed.", referrer ?? specifier, error);
            }
            cancellationToken.ThrowIfCancellationRequested();
            if (resolved is null || string.IsNullOrWhiteSpace(resolved.Id) || resolved.Content is null)
                throw ValueType.Error(referrer ?? specifier, "The source resolver must return a canonical identity and content.");
            requests.Add((referrer, specifier), resolved.Id);
            if (resources.TryGetValue(resolved.Id, out var existing))
            {
                if (existing.Source.Content != resolved.Content || existing.Source.Revision != resolved.Revision)
                    throw ValueType.Error(resolved.Id, "One canonical source identity resolved to conflicting content or revisions.");
                return resolved.Id;
            }
            var resource = ReadResource(resolved);
            resources.Add(resolved.Id, resource);
            foreach (var dependency in resource.References)
            {
                var id = await Load(dependency, resolved.Id).ConfigureAwait(false);
                if (!resource.Dependencies.Contains(id, StringComparer.Ordinal)) resource.Dependencies.Add(id);
            }
            return resolved.Id;
        }
    }

    private static CompiledComponentGraph Link(IEnumerable<SourceResource> resources, CancellationToken cancellation, HtmlNextServerAssets? assets)
    {
        var references = new Dictionary<string, ComponentReference>(StringComparer.Ordinal);
        var compilers = new List<(Compiler Compiler, ComponentReference Reference)>();
        var sources = new List<CompiledSource>();
        foreach (var resource in resources)
        {
            cancellation.ThrowIfCancellationRequested();
            var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(resource.Source.Content)));
            foreach (var carrier in resource.Carriers)
            {
                var compiler = new Compiler(carrier, resource.Source.Id, references, assets, hash);
                compiler.ReadContract();
                var reference = new ComponentReference { Props = compiler.Props, Slots = compiler.Slots, DelegatedTag = compiler.DelegatedTag };
                if (!references.TryAdd(compiler.Tag, reference)) throw ValueType.Error(resource.Source.Id, $"Duplicate component '{compiler.Tag}'.");
                compilers.Add((compiler, reference));
            }
            sources.Add(new(resource.Source.Id, resource.Source.Revision,
                hash,
                Array.AsReadOnly(resource.Dependencies.ToArray())));
        }
        foreach (var (compiler, _) in compilers) compiler.FindInvocationAttributes();
        bool changed;
        do
        {
            changed = false;
            foreach (var (compiler, reference) in compilers)
                if (reference.ReceivesAttributes && compiler.DelegatedTag is { } tag && references.TryGetValue(tag, out var delegated) && !delegated.ReceivesAttributes)
                {
                    delegated.ReceivesAttributes = true;
                    changed = true;
                }
        } while (changed);
        foreach (var (compiler, reference) in compilers)
        {
            cancellation.ThrowIfCancellationRequested();
            reference.Template = compiler.Compile();
        }
        foreach (var reference in references.Values) { reference.Props = []; reference.Slots = ComponentReference.EmptySlots; }
        return new(references.ToDictionary(pair => pair.Key, pair => pair.Value.Template, StringComparer.Ordinal), sources.ToArray(), assets);
    }

    private sealed class SourceResource(HtmlNextSource source, IDocument document, IHtmlTemplateElement[] carriers, string[] references) : IDisposable
    {
        public HtmlNextSource Source { get; } = source;
        public IHtmlTemplateElement[] Carriers { get; } = carriers;
        public string[] References { get; } = references;
        public List<string> Dependencies { get; } = [];
        public void Dispose() => document.Dispose();
    }

    private static SourceResource ReadResource(HtmlNextSource source)
    {
        var parser = new HtmlParser();
        var document = parser.ParseDocument("");
        try
        {
            parser.Error += (_, error) =>
            {
                if (error is AngleSharp.Html.Dom.Events.HtmlErrorEvent detail)
                    throw ValueType.Error(source.Id, $"HTML parsing failed at {detail.Position}: {detail.Message}");
            };
            var carriers = new List<IHtmlTemplateElement>();
            var dependencies = new List<string>();
            foreach (var node in parser.ParseFragment(source.Content, document.Body!).Where(Significant))
            {
                if (node is IHtmlTemplateElement carrier && carrier.HasAttribute("component")) { carriers.Add(carrier); continue; }
                if (node is IElement { LocalName: "link" } link && Rel(link, "component") && !Rel(link, "import"))
                {
                    RejectExecutableAttributes(link, source.Id);
                    var href = link.GetAttribute("href");
                    if (string.IsNullOrWhiteSpace(href)) throw ValueType.Error(source.Id, "A component dependency requires a nonempty href.");
                    if (!dependencies.Contains(href, StringComparer.Ordinal)) dependencies.Add(href);
                    continue;
                }
                if (node is IElement metadata && Metadata(metadata, source.Id)) continue;
                throw ValueType.Error(source.Id, "Invalid component resource content; expected component carriers, dependency links or inert metadata.");
            }
            if (carriers.Count == 0) throw ValueType.Error(source.Id, "A component resource requires at least one <template component>.");
            return new(source, document, carriers.ToArray(), dependencies.ToArray());
        }
        catch { document.Dispose(); throw; }
    }

    private static bool Rel(IElement element, string value) => (element.GetAttribute("rel") ?? "")
        .Split([' ', '\t', '\n', '\r', '\f'], StringSplitOptions.RemoveEmptyEntries).Contains(value, StringComparer.OrdinalIgnoreCase);

    private static bool Metadata(IElement element, string source)
    {
        var allowed = element.LocalName == "title" || element.LocalName == "meta" && !element.HasAttribute("http-equiv")
            || element.LocalName == "link" && !Rel(element, "component") && !Rel(element, "import");
        if (allowed) RejectExecutableAttributes(element, source);
        return allowed;
    }

    private static void RejectExecutableAttributes(IElement element, string source)
    {
        foreach (var attribute in element.Attributes)
            if (attribute.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase)) throw ValueType.Error(source, "Executable event attributes are invalid in component metadata or dependency links.");
    }
}
