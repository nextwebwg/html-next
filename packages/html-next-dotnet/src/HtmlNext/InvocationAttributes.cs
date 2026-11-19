using System.Text.Json;

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
        if (Target == "value-property")
        {
            if (value.IsInvalid) return false;
            text = InputValueProperty.Text(value, Source); return true;
        }
        if (Target == "class") { if (value.IsInvalid) return false; text = value.Truthy ? "true" : "false"; return true; }
        if (Target == "style")
        {
            if (value.IsInvalid) return false;
            if (value.IsNull || value.IsAbsent || value.Type.Kind == "object") { text = ""; return true; }
            var styleCounter = HtmlWriter.Counter(); BoundAttribute.RawText(ref styleCounter, value, Source);
            text = string.Create(styleCounter.Length, (Value: value, Source), static (span, state) =>
            {
                var writer = new HtmlWriter(span); BoundAttribute.RawText(ref writer, state.Value, state.Source);
            });
            return true;
        }
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
        else if (attribute.Target == "style")
        {
            var previous = output.GetValueOrDefault("style");
            var next = InlineStyle.Write(previous, attribute.Name, text ?? "");
            if (!ReferenceEquals(previous, next)) output["style"] = next;
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
            else if (attribute.Target == "style" && HtmlNextCompiler.AsciiEquals(name, "style") && attribute.TryRead(caller, out var value))
            {
                var next = InlineStyle.Write(text, attribute.Name, value ?? "");
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

internal sealed record ForwardedElementAttributes(InvocationAttribute?[] Attributes, RootStyle? Owner = null, CheckedInputProperty? Checked = null, TextareaValueProperty? Textarea = null) : RenderOperation
{
    private readonly RenderOperation[]? direct = Checked is null && Textarea is null ? Direct(Attributes, Owner) : null;
    private readonly string? valueSource = Attributes.FirstOrDefault(attribute => attribute?.Target == "value-property")?.Source;

    private static RenderOperation[]? Direct(InvocationAttribute?[] attributes, RootStyle? owner)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<RenderOperation>();
        foreach (var attribute in attributes)
        {
            if (attribute is null || owner is not null && attribute.Name == "component") continue;
            if (attribute.Target is not null || attribute.Prop is not null || !names.Add(attribute.Name)) return null;
            result.Add(owner is null ? attribute : new RootAuthoredAttribute(attribute.Name, attribute, owner));
        }
        return result.ToArray();
    }

    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (direct is not null && writer.Context?.InvocationAttributesFor(values) is null)
        {
            foreach (var attribute in direct) attribute.Write(ref writer, values, cancellation);
            return;
        }
        var output = writer.Context?.AttributeOutput() ?? new Dictionary<string, string?>(StringComparer.Ordinal);
        var valueProperty = valueSource is null ? null : new InputValueProperty(valueSource);
        foreach (var attribute in Attributes)
        {
            if (attribute is null && writer.Context?.InvocationAttributesFor(values) is { } inputs)
            {
                var forwarded = writer.Context.ForwardedAttributeOutput();
                inputs.Apply(forwarded);
                foreach (var (name, text) in forwarded) if (text is not null) { output[name] = text; valueProperty?.Attribute(name, text); }
            }
            else if (attribute is not null && attribute.TryRead(values, out var text))
            {
                InvocationAttributeFrame.Apply(output, attribute, text);
                if (attribute.Target == "value-property") valueProperty!.Property(text!);
                else if (attribute.Target is null) valueProperty?.Attribute(attribute.Name, output.GetValueOrDefault(attribute.Name));
            }
        }
        Dictionary<string, object?>? defaults = null;
        valueProperty?.Apply(output, ref defaults);
        Checked?.Apply(output, values, ref defaults);
        if (defaults is not null) output["data-html-next-form-defaults"] = JsonSerializer.Serialize(defaults);
        Textarea?.Attributes(output, values, cancellation);
        foreach (var (name, text) in output)
        {
            if (text is null) continue;
            if (Owner is not null)
            {
                if (name == "component" || Owner.Manages(name, values, writer.Context)) continue;
                var managed = false;
                if (writer.Context is { } context) foreach (var parent in context.RootStyles())
                    if (parent.Style.Manages(name, parent.Values, context)) { managed = true; break; }
                if (managed) continue;
            }
            writer.Write(' '); writer.Write(name); writer.Write("=\""); HtmlOutput.Escape(ref writer, text.AsSpan(), true); writer.Write('"');
        }
    }
}

internal sealed record CheckedInputProperty(ValueExpression Expression)
{
    public void Apply(Dictionary<string, string?> output, object?[] values, ref Dictionary<string, object?>? defaults)
    {
        var value = Expression.Evaluate(values);
        if (value.IsInvalid) return;
        // The native boolean property uses Web IDL conversion, including truthy empty containers.
        var current = value.Type.Kind is "object" or "list" || value.Truthy;
        var authored = output.GetValueOrDefault("checked") is not null;
        if (current == authored) return;
        output["checked"] = current ? "" : null;
        defaults ??= new(StringComparer.Ordinal);
        defaults["checked"] = authored;
    }
}
