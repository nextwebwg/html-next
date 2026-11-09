using System.Text.Json;

namespace HtmlNext;

internal sealed class TextareaValueProperty(int slot, ValueExpression expression, string source)
{
    private RenderOperation[] contents = [];
    public void SetContents(RenderOperation[] value) => contents = value;

    public void Attributes(Dictionary<string, string?> output, object?[] values, CancellationToken cancellation)
    {
        using var text = new StringWriter();
        var writer = new HtmlWriter(text);
        foreach (var operation in contents) operation.Write(ref writer, values, cancellation);
        var reset = text.ToString();
        var value = expression.Evaluate(values);
        var current = value.IsInvalid ? reset : InputValueProperty.Text(value, source);
        values[slot] = current;
        if (current != reset) output["data-html-next-form-defaults"] = JsonSerializer.Serialize(new { value = reset });
    }

    public void Write(ref HtmlWriter writer, object?[] values)
    {
        var current = (string)values[slot]!;
        // HTML parsing ignores one initial LF after a textarea start tag.
        if (current.StartsWith('\n') || current.StartsWith('\r')) writer.Write('\n');
        HtmlOutput.Escape(ref writer, current, false);
    }
}

internal sealed record TextareaValueContent(TextareaValueProperty Property) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => Property.Write(ref writer, values);
}

internal sealed record PlainExpressionText(ValueExpression Expression) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => writer.Write(Expression.Evaluate(values).ScalarText());
}
