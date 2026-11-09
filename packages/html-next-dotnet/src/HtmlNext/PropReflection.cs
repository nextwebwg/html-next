using System.Text;

namespace HtmlNext;

internal sealed class PropReflectionPlan(int slot, string tag, Prop[] props, string[] boundNames, string source)
{
    private static readonly object Explicit = new();
    private readonly string prefix = "data-" + tag + "-prop-";
    private readonly string[] attributes = props.Select(prop => "data-" + tag + "-prop-" + prop.AttributeName).ToArray();
    private readonly bool[] bound = props.Select(prop => boundNames.Contains("data-" + tag + "-prop-" + prop.AttributeName, StringComparer.Ordinal)).ToArray();

    public void Capture(object?[] values, int index, object? input, bool present)
    {
        present &= input is not null && !ReferenceEquals(input, ExpressionValue.AbsentStorage)
            && (input is not ExpressionValue value || !value.IsNull && !Unavailable(value));
        if (values[slot] is object?[] inputs) inputs[index] = present ? Explicit : null;
        else if (present) { inputs = new object?[props.Length]; inputs[index] = Explicit; values[slot] = inputs; }
    }

    public bool Manages(string attribute, object?[] values)
    {
        if (!attribute.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var index = Array.IndexOf(attributes, attribute);
        return index >= 0 && (bound[index] || values[slot] is object?[] inputs && inputs[index] is not null);
    }

    public void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        var inputs = values[slot] as object?[];
        for (var index = 0; index < props.Length; index++)
        {
            if (!bound[index] && inputs?[index] is null) continue;
            var value = ExpressionValue.StoredValue(values[index], props[index].Type);
            if (value.IsNull || Unavailable(value)) continue;
            inputs ??= (object?[])(values[slot] = new object?[props.Length]);
            var text = inputs[index] as string;
            if (text is null) inputs[index] = text = Text(value, cancellation);
            writer.Write(' '); writer.Write(attributes[index]); writer.Write("=\"");
            HtmlOutput.Escape(ref writer, text, true); writer.Write('"');
        }
    }

    private string Text(ExpressionValue value, CancellationToken cancellation)
    {
        if (value.Type.Kind is not ("object" or "list")) return value.IsNumeric && value.Number == 0 ? "0" : value.ScalarText();
        var text = new StringBuilder();
        var ancestors = new HashSet<object>(ReferenceEqualityComparer.Instance);
        Write(value);
        return text.ToString();

        void Write(ExpressionValue item)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            if (item.Type.Kind is "object" or "list")
            {
                if (!ancestors.Add(item.Data!)) throw new HtmlNextException("HNCS008", "Prop metadata requires serializable data without cycles.", source);
                var record = item.Type.Kind == "object";
                text.Append(record ? '{' : '[');
                var first = true;
                foreach (var index in BindingValueCodec.Indices(item))
                {
                    var child = item.ItemUnchecked(index);
                    if (record && Unavailable(child)) continue;
                    if (!first) text.Append(','); first = false;
                    if (record) { BindingValueCodec.AppendJsonString(text, item.Type.Fields![index].Name); text.Append(':'); }
                    Write(child);
                }
                text.Append(record ? '}' : ']');
                ancestors.Remove(item.Data!);
            }
            else if (item.IsNull || Unavailable(item)) text.Append("null");
            else if (item.IsText || item.IsDimension) BindingValueCodec.AppendJsonString(text, item.ScalarText());
            else text.Append(item.IsNumeric && item.Number == 0 ? "0" : item.ScalarText());
        }
    }

    private static bool Unavailable(ExpressionValue value) => value.IsAbsent || value.IsInvalid || value.Type.Kind == "undefined";
}
