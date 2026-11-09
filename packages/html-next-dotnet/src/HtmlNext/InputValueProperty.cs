using System.Text;

namespace HtmlNext;

// Encode the initial value for native HTML parsing; the existing client restores reset defaults.
internal sealed class InputValueProperty(string source)
{
    private string? current;
    private string? reset;

    public void Attribute(string name, string? text) { if (name == "value") reset = text; }
    public void Property(string text) => current = text;

    public void Apply(Dictionary<string, string?> output, ref Dictionary<string, object?>? defaults)
    {
        if (current is null) return;
        var type = HtmlNextCompiler.AsciiLowerCase(output.GetValueOrDefault("type") ?? "text");
        if (type is "hidden" or "button" or "submit" or "reset" or "image" or "checkbox" or "radio") return;
        if (type == "file")
        {
            if (current.Length > 0) throw new HtmlNextException("HNCS002", "A file input's value property accepts only an empty string.", source);
            output["value"] = reset;
            return;
        }
        if (current == (reset ?? "")) { output["value"] = reset; return; }
        output["value"] = current;
        defaults ??= new(StringComparer.Ordinal);
        defaults["value"] = reset ?? "";
        defaults["valuePresent"] = reset is not null;
    }

    public static string Text(ExpressionValue value, string source)
    {
        HashSet<object>? ancestors = null;
        return Read(value, false);

        string Read(ExpressionValue item, bool member)
        {
            if (item.IsNull || member && item.Type.Kind == "undefined") return "";
            if (item.IsAbsent || item.IsInvalid) throw new HtmlNextException("HNCS002", "An absent value cannot be converted to a native value property string.", source);
            if (item.Type.Kind == "object")
            {
                if (item.Type.Fields!.Any(field => field.Name == "toString"))
                    throw new HtmlNextException("HNCS002", "An object without a callable toString cannot be converted to a native value property string.", source);
                return "[object Object]";
            }
            if (item.Type.Kind != "list") return item.ScalarText();
            ancestors ??= new(ReferenceEqualityComparer.Instance);
            if (!ancestors.Add(item.Data!)) return "";
            ExecutionStack.Check(source);
            var text = new StringBuilder();
            for (var index = 0; index < item.Count; index++)
            {
                if (index > 0) text.Append(',');
                text.Append(Read(item.ItemUnchecked(index), true));
            }
            ancestors.Remove(item.Data!);
            return text.ToString();
        }
    }
}
