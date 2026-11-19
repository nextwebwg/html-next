using System.Text.RegularExpressions;
using AngleSharp.Dom;

namespace HtmlNext;

internal static partial class InterfaceDeclarations
{
    [GeneratedRegex(@"^[a-z][a-z0-9-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex EventName();

    public static void Read(IEnumerable<IElement> declarations, IReadOnlyList<Prop> props, string source, Func<string, ValueType, object?> parse)
    {
        var events = new HashSet<string>(StringComparer.Ordinal);
        var requests = new HashSet<string>(StringComparer.Ordinal);
        foreach (var declaration in declarations.Where(element => element.LocalName is "event" or "request"))
        {
            var kind = declaration.LocalName;
            var name = declaration.GetAttribute("name");
            if (string.IsNullOrEmpty(name)) throw ValueType.Error(source, $"An <{kind}> requires a name.");
            if (!EventName().IsMatch(name)) throw ValueType.Error(source, $"{kind} name '{name}' must be lowercase kebab case.");
            if (name == "responder") throw ValueType.Error(source, $"An <{kind}> cannot declare the host event 'responder'.");
            if (!(kind == "event" ? events : requests).Add(name)) throw ValueType.Error(source, $"{kind} '{name}' is declared more than once.");
            if (kind == "event") ReadType(declaration, new("object", Fields: [], Open: true), source, parse);
            else
            {
                var answers = declaration.Children.Where(child => child.LocalName == "returns").ToArray();
                if (answers.Length > 1 || answers.Length == 1 && declaration.HasAttribute("returns"))
                    throw ValueType.Error(source, $"Request '{name}' declares its answer's type once, by returns or one <returns>.");
                ReadType(declaration, new("null"), source, parse);
                if (answers.Length == 1) ReadType(answers[0], null, source, parse);
                else if (declaration.GetAttribute("returns") is { } answer) ValueType.Parse(answer, source, javaScriptValues: true);
                var property = Regex.Replace(name, "-([a-z])", match => match.Groups[1].Value.ToUpperInvariant());
                if (props.Any(prop => prop.Name == property)) throw ValueType.Error(source, $"Request '{name}' and prop '{property}' collide as a framework prop.");
            }
        }
        foreach (var name in requests)
            if (events.Contains(name)) throw ValueType.Error(source, $"Event and request '{name}' share a name.");
    }

    private static ValueType ReadType(IElement declaration, ValueType? fallback, string source, Func<string, ValueType, object?> parse)
    {
        if (declaration.HasAttribute("nullable")) throw ValueType.Error(source, "nullable is not a declaration attribute; null clears a declared value to its default.");
        if (declaration.HasAttribute("pattern")) throw ValueType.Error(source, "The pattern constraint is not implemented in the measured rendering slice.");
        var fields = declaration.Children.Where(child => child.LocalName == "prop").ToArray();
        var expanded = fields.Length > 0 || declaration.Attributes.Any(attribute => attribute.Name is "open" or "values" or "min" or "max" or "minlength" or "maxlength");
        if (fallback is not null && !declaration.HasAttribute("type") && !expanded) return fallback;
        return DeclarationTypes.Read(declaration, source, true, parse, javaScriptValues: true, fieldElements: fields);
    }
}
