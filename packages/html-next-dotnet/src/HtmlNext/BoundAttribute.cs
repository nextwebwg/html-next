namespace HtmlNext;

internal enum BoundAttributeKind { Ordinary, EnumeratedBoolean, Url }

internal static class BoundAttribute
{
    public static BoundAttributeKind Kind(string name) => BoundAttributeRules.IsUrl(name) ? BoundAttributeKind.Url
        : BoundAttributeRules.IsEnumeratedBoolean(name) ? BoundAttributeKind.EnumeratedBoolean : BoundAttributeKind.Ordinary;

    public static bool Present(ExpressionValue value, BoundAttributeKind kind, string source)
    {
        if (value.IsNull || value.IsAbsent || value.IsInvalid || value.Type.Kind == "object") return false;
        if (value.Type.Kind == "boolean") return value.Number != 0 || kind == BoundAttributeKind.EnumeratedBoolean;
        return ValidText(value, source);
    }

    public static bool ValidText(ExpressionValue value, string source)
    {
        if (value.IsInvalid) return false;
        if (value.Type.Kind != "list") return true;
        ExecutionStack.Check(source);
        for (var i = 0; i < value.Count; i++) if (!ValidText(value.Item(i), source)) return false;
        return true;
    }

    public static void WriteFallback(ref HtmlWriter writer, ExpressionValue value, string? fallback, string source)
    {
        if (fallback is not null && !ValidText(value, source)) writer.Write(fallback);
    }

    public static void Write(ref HtmlWriter writer, string name, ExpressionValue value, BoundAttributeKind kind, string source, string? fallback = null)
    {
        if (!Present(value, kind, source)) { WriteFallback(ref writer, value, fallback, source); return; }
        if (kind == BoundAttributeKind.Url && ExecutableUrl(value, source)) return;
        Open(ref writer, name);
        if (value.Type.Kind != "boolean" || kind == BoundAttributeKind.EnumeratedBoolean) Text(ref writer, value, source);
        writer.Write('"');
    }

    public static void Open(ref HtmlWriter writer, string name)
    {
        writer.Write(' '); writer.Write(name); writer.Write("=\"");
    }

    public static void Text(ref HtmlWriter writer, ExpressionValue value, string source)
    {
        if (value.Type.Kind != "list") { value.Write(ref writer, true); return; }
        ExecutionStack.Check(source);
        for (var i = 0; i < value.Count; i++)
        {
            if (i > 0) writer.Write(' ');
            Text(ref writer, value.Item(i), source);
        }
    }

    public static void RawText(ref HtmlWriter writer, ExpressionValue value, string source)
    {
        if (value.Type.Kind != "list") { value.WriteRaw(ref writer); return; }
        ExecutionStack.Check(source);
        for (var index = 0; index < value.Count; index++)
        {
            if (index > 0) writer.Write(' ');
            RawText(ref writer, value.Item(index), source);
        }
    }

    public static bool ExecutableUrl(string value)
    {
        Span<char> prefix = stackalloc char[11];
        var length = 0;
        Prefix(value, prefix, ref length);
        return ExecutablePrefix(prefix[..length]);
    }

    public static bool ExecutableUrl(ExpressionValue value, string source)
    {
        Span<char> prefix = stackalloc char[11];
        var length = 0;
        Prefix(value, prefix, ref length, source);
        return ExecutablePrefix(prefix[..length]);
    }

    public static bool ExecutableUrlParts(ReadOnlySpan<ExpressionValue> arguments, bool joined, string source)
    {
        Span<char> prefix = stackalloc char[11];
        var length = 0;
        if (!joined) foreach (var argument in arguments) Prefix(argument, prefix, ref length, source);
        else
        {
            var list = arguments[0];
            for (var i = 0; i < list.Count && length < prefix.Length; i++)
            {
                if (i > 0) Prefix(arguments[1], prefix, ref length, source);
                Prefix(list.Item(i), prefix, ref length, source);
            }
        }
        return ExecutablePrefix(prefix[..length]);
    }

    private static bool ExecutablePrefix(ReadOnlySpan<char> prefix) => prefix.StartsWith("data:", StringComparison.Ordinal)
        || prefix.StartsWith("javascript:", StringComparison.Ordinal) || prefix.StartsWith("vbscript:", StringComparison.Ordinal);

    private static void Prefix(ExpressionValue value, Span<char> prefix, ref int length, string source)
    {
        if (length == prefix.Length) return;
        if (value.IsText) Prefix((string)value.Data!, prefix, ref length);
        else if (value.Type.Kind == "list")
        {
            ExecutionStack.Check(source);
            for (var i = 0; i < value.Count && length < prefix.Length; i++) Prefix(value.Item(i), prefix, ref length, source);
        }
        else if (value.Type.Kind == "boolean") Prefix(value.Number == 0 ? "false" : "true", prefix, ref length);
        // A numeric character prevents these alphabetic schemes from matching, including in a list.
        else if (value.IsNumeric || value.IsDimension) Prefix("0", prefix, ref length);
    }

    private static void Prefix(string value, Span<char> prefix, ref int length)
    {
        foreach (var character in value)
        {
            if (length == prefix.Length) return;
            if (character <= ' ' || character == '\u007f') continue;
            prefix[length++] = character is >= 'A' and <= 'Z' ? (char)(character + ('a' - 'A')) : character;
        }
    }
}
