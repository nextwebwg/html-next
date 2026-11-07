namespace HtmlNext;

internal sealed record InvocationAttribute(string Name, string? Literal, ValueExpression? Expression, string Source, string? Target = null, DeferredPropAttribute? Prop = null) : RenderOperation
{
    private readonly BoundAttributeKind kind = BoundAttribute.Kind(Name);
    private readonly string? markup = Literal is null ? null : " " + Name + "=\"" + HtmlOutput.Escape(Literal, true) + "\"";

    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (Expression is null) writer.Write(markup);
        else BoundAttribute.Write(ref writer, Name, Expression.Evaluate(values), kind, Source, markup);
    }

    public bool TryRead(object?[] values, out string? text)
    {
        text = Literal;
        if (Expression is null && Prop is null) return true;
        var value = Prop?.Read(values) ?? Expression!.Evaluate(values);
        if (Target == "class") { if (value.IsInvalid) return false; text = value.Truthy ? "true" : "false"; return true; }
        if (!BoundAttribute.ValidText(value, Source)) return Literal is not null;
        if (!BoundAttribute.Present(value, kind, Source) || kind == BoundAttributeKind.Url && BoundAttribute.ExecutableUrl(value, Source)) { text = null; return true; }
        if (value.Type.Kind == "boolean" && kind != BoundAttributeKind.EnumeratedBoolean) { text = ""; return true; }
        if (value.IsText) { text = (string)value.Data!; return true; }
        var counter = HtmlWriter.Counter(); BoundAttribute.RawText(ref counter, value, Source);
        text = string.Create(counter.Length, (Value: value, Source), static (span, state) =>
        {
            var writer = new HtmlWriter(span); BoundAttribute.RawText(ref writer, state.Value, state.Source);
        });
        return true;
    }
}

internal sealed class InvocationAttributeFrame(InvocationAttribute?[] attributes, Prop[] props, object?[] caller, object?[] receiver, InvocationAttributeFrame? parent)
{
    public InvocationAttribute?[] Attributes = attributes;
    public Prop[] Props = props;
    public object?[] Caller = caller;
    public object?[] Receiver = receiver;
    public InvocationAttributeFrame? Parent = parent;
    private bool Consumed(string name)
    {
        foreach (var prop in Props) if (Matches(name, prop)) return true;
        return false;
    }
    internal static bool Matches(string name, Prop prop) => HtmlNextCompiler.AsciiEquals(name, prop.Name) || HtmlNextCompiler.AsciiEquals(name, prop.AttributeName);

    public void Apply(Dictionary<string, string?> output)
    {
        foreach (var attribute in Attributes)
        {
            if (attribute is null) Parent?.Apply(output);
            else if (attribute.TryRead(Caller, out var text)) Apply(output, attribute, text);
        }
        foreach (var prop in Props)
        {
            output.Remove(HtmlNextCompiler.AsciiLowerCase(prop.Name));
            output.Remove(prop.AttributeName);
        }
    }

    internal static void Apply(Dictionary<string, string?> output, InvocationAttribute attribute, string? text)
    {
        if (attribute.Target == "class")
        {
            var previous = output.GetValueOrDefault("class");
            var next = Toggle(previous, attribute.Name, text == "true");
            if (!ReferenceEquals(previous, next)) output["class"] = next;
        }
        else output[attribute.Name] = text;
    }

    private static string? Toggle(string? text, string token, bool enabled)
    {
        if (ClassBinding.Contains(text.AsSpan(), token.AsSpan()) == enabled) return text;
        var tokens = (text ?? "").Split([' ', '\t', '\n', '\r', '\f'], StringSplitOptions.RemoveEmptyEntries);
        return string.Join(" ", enabled ? tokens.Append(token).Distinct(StringComparer.Ordinal) : tokens.Where(value => value != token).Distinct(StringComparer.Ordinal));
    }

    public bool Read(string name, out string? text)
    {
        text = null;
        if (Consumed(name)) return false;
        return Read(Attributes, Caller, Parent, name, out text);
    }

    internal static bool Read(InvocationAttribute?[] attributes, object?[] caller, InvocationAttributeFrame? parent, string name, out string? text)
    {
        text = null;
        var found = false;
        foreach (var attribute in attributes)
        {
            if (attribute is null)
            {
                if (parent is not null && parent.Read(name, out var forwarded)) { text = forwarded; found = true; }
            }
            else if (attribute.Target == "class" && HtmlNextCompiler.AsciiEquals(name, "class") && attribute.TryRead(caller, out var enabled))
            {
                var next = Toggle(text, attribute.Name, enabled == "true");
                if (!ReferenceEquals(text, next)) { text = next; found = true; }
            }
            else if (attribute.Target is null && HtmlNextCompiler.AsciiEquals(attribute.Name, name) && attribute.TryRead(caller, out var own)) { text = own; found = true; }
        }
        return found && text is not null;
    }
}

internal sealed class InvocationAttributeState
{
    private readonly List<InvocationAttributeFrame> frames = [];
    private int count;
    public InvocationAttributeFrame? Find(object?[] values)
    {
        for (var index = count - 1; index >= 0; index--) if (ReferenceEquals(frames[index].Receiver, values)) return frames[index];
        return null;
    }
    public int Enter(InvocationAttribute?[] attributes, Prop[] props, object?[] caller, object?[] receiver, InvocationAttributeFrame? parent)
    {
        var previous = count;
        if (count == frames.Count) frames.Add(new(attributes, props, caller, receiver, parent));
        else
        {
            var frame = frames[count];
            frame.Attributes = attributes; frame.Props = props; frame.Caller = caller; frame.Receiver = receiver; frame.Parent = parent;
        }
        count++;
        return previous;
    }
    public void Leave(int previous) => count = previous;
}

internal sealed record ForwardedElementAttributes(InvocationAttribute?[] Attributes) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        var output = writer.Context?.AttributeOutput() ?? new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var attribute in Attributes)
        {
            if (attribute is null && writer.Context?.InvocationAttributesFor(values) is { } inputs)
            {
                var forwarded = writer.Context.ForwardedAttributeOutput();
                inputs.Apply(forwarded);
                foreach (var (name, text) in forwarded) if (text is not null) output[name] = text;
            }
            else if (attribute is not null && attribute.TryRead(values, out var text))
            {
                InvocationAttributeFrame.Apply(output, attribute, text);
            }
        }
        foreach (var (name, text) in output)
        {
            if (text is null) continue;
            writer.Write(' '); writer.Write(name); writer.Write("=\""); HtmlOutput.Escape(ref writer, text.AsSpan(), true); writer.Write('"');
        }
    }
}
