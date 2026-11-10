using AngleSharp.Dom;

namespace HtmlNext;

internal static class DeclarationTypes
{
    public static void CheckAttributes(IElement declaration, string source, bool nested = false)
    {
        foreach (var attribute in declaration.Attributes)
            if (attribute.Name is "pattern" or "nullable" or "nonce" or "blocking"
                || nested && attribute.Name == "default" || attribute.Name.StartsWith('$')
                || attribute.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || attribute.Name.Contains(':'))
                throw ValueType.Error(source, $"Unsupported declaration attribute '{attribute.Name}'.");
    }

    public static ValueType Read(IElement declaration, string source, bool nested, Func<string, ValueType, object?> parse, bool javaScriptValues = false, IElement[]? fieldElements = null)
    {
        ExecutionStack.Check(source);
        var written = declaration.GetAttribute("type") ?? (nested ? throw ValueType.Error(source, "A nested field requires a type.") : "string");
        var children = fieldElements ?? declaration.Children.ToArray();
        if (children.Any(child => child.LocalName != "prop")) throw ValueType.Error(source, "Only nested prop fields belong in a structured declaration.");
        foreach (var child in children) CheckAttributes(child, source, nested: true);
        if (declaration.HasAttribute("open") && written != "object") throw ValueType.Error(source, "Only an expanded object can be open.");
        ValueType type;
        if (written == "list")
        {
            if (children.Length != 1 || children[0].HasAttribute("name")) throw ValueType.Error(source, "A list requires one unnamed item prop.");
            type = new("list", Read(children[0], source, true, parse, javaScriptValues));
        }
        else if (written == "object" && (children.Length > 0 || declaration.HasAttribute("open")))
        {
            var fields = new List<ValueType.Field>();
            foreach (var child in children)
            {
                var name = child.GetAttribute("name");
                if (string.IsNullOrEmpty(name) || fields.Any(field => field.Name == name)) throw ValueType.Error(source, "Object fields require distinct nonempty names.");
                fields.Add(new(name, Read(child, source, true, parse, javaScriptValues), !child.HasAttribute("required")));
            }
            type = new("object", Fields: fields.ToArray(), Open: declaration.HasAttribute("open"));
        }
        else
        {
            if (children.Length > 0) throw ValueType.Error(source, "Only object and list declarations contain prop fields.");
            type = ValueType.Parse(written, source, javaScriptValues);
        }
        if (nested) type = type with { Constraints = ValueConstraints.Read(declaration, type, source, parse) };
        return type;
    }
}
