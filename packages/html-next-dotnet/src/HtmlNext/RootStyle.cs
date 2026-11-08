namespace HtmlNext;

internal sealed record RootStyleState(string Name, ValueExpression Read);

internal sealed record RootStyle(string Tag, RootStyleState[] States, string Source, string[]? AuthoredIdentity = null, InstanceRecordPlan? Instance = null) : RenderOperation
{
    private readonly string stateAttribute = "data-" + Tag + "-state";
    public bool Manages(string attribute) => States.Length > 0 && attribute == stateAttribute;

    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellationToken)
    {
        writer.Write(" component=\"");
        var context = writer.Context;
        var first = true;
        if (AuthoredIdentity is not null) foreach (var token in AuthoredIdentity) WriteToken(ref writer, token, ref first);
        if (context is not null) foreach (var parent in context.RootStyles())
            if (AuthoredIdentity is null || !AuthoredIdentity.Contains(parent.Style.Tag, StringComparer.Ordinal)) WriteToken(ref writer, parent.Style.Tag, ref first);
        if (AuthoredIdentity is null || !AuthoredIdentity.Contains(Tag, StringComparer.Ordinal)) WriteToken(ref writer, Tag, ref first);
        writer.Write('"');
        if (context is not null) foreach (var parent in context.RootStyles()) parent.Style.WriteStates(ref writer, parent.Values);
        WriteStates(ref writer, values);
        if (context?.Interactive == true) Instance?.Write(ref writer, values, context, cancellationToken);
    }

    private static void WriteToken(ref HtmlWriter writer, string token, ref bool first)
    {
        if (!first) writer.Write(' ');
        HtmlOutput.Escape(ref writer, token, true);
        first = false;
    }

    private void WriteStates(ref HtmlWriter writer, object?[] values)
    {
        if (States.Length == 0) return;
        Span<char> buffer = stackalloc char[64];
        var started = false;
        foreach (var state in States)
        {
            var value = state.Read.EvaluateUnchecked(values);
            var text = value.Data as string;
            if (text is null && value.IsDimension) text = value.ScalarText();
            var scalar = text is not null || value.IsNumeric;
            var truthy = text is not null ? text.Length > 0 : (value.IsNumeric || value.Type.Kind == "boolean") && value.Number != 0;
            if (!scalar && !truthy) continue;
            if (!started) { writer.Write(" data-"); writer.Write(Tag); writer.Write("-state=\""); started = true; }
            else writer.Write(' ');
            HtmlOutput.Escape(ref writer, state.Name, true);
            if (truthy && scalar) { writer.Write(' '); HtmlOutput.Escape(ref writer, state.Name, true); }
            if (scalar)
            {
                writer.Write('=');
                if (text is not null) HtmlOutput.Escape(ref writer, Encode(text), true);
                else
                {
                    var formatted = new HtmlWriter(buffer);
                    HtmlOutput.Number(ref formatted, value.Number);
                    // Invariant numeric output is ASCII; only '+' needs URI escaping.
                    foreach (var character in buffer[..formatted.Length])
                        if (character == '+') writer.Write("%2B"); else writer.Write(character);
                }
            }
        }
        if (started) writer.Write('"');
    }

    private string Encode(string value)
    {
        // encodeURIComponent rejects unpaired surrogates; Uri.EscapeDataString replaces them.
        for (var i = 0; i < value.Length; i++) if (char.IsSurrogate(value[i]))
        {
            if (!char.IsHighSurrogate(value[i]) || i + 1 == value.Length || !char.IsLowSurrogate(value[i + 1]))
                throw new HtmlNextException("HNCS002", "A CSS state value contains invalid UTF-16.", Source);
            i++;
        }
        return Uri.EscapeDataString(value)
            .Replace("%21", "!", StringComparison.Ordinal).Replace("%27", "'", StringComparison.Ordinal)
            .Replace("%28", "(", StringComparison.Ordinal).Replace("%29", ")", StringComparison.Ordinal).Replace("%2A", "*", StringComparison.Ordinal);
    }
}

internal sealed record RootAuthoredAttribute(string Name, RenderOperation Attribute, RootStyle Owner) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellationToken)
    {
        if (Owner.Manages(Name)) return;
        if (writer.Context is { } context) foreach (var parent in context.RootStyles()) if (parent.Style.Manages(Name)) return;
        Attribute.Write(ref writer, values, cancellationToken);
    }
}
