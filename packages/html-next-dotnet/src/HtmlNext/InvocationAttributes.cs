using System.Runtime.InteropServices;

namespace HtmlNext;

internal sealed record InvocationAttribute(string Name, string? Literal, ValueExpression? Expression, string Source) : RenderOperation
{
    private readonly BoundAttributeKind kind = BoundAttribute.Kind(Name);
    private readonly string? markup = Literal is null ? null : " " + Name + "=\"" + HtmlOutput.Escape(Literal, true) + "\"";

    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (Expression is null) writer.Write(markup);
        else BoundAttribute.Write(ref writer, Name, Expression.Evaluate(values), kind, Source, markup);
    }

    public string? Read(object?[] values)
    {
        if (Expression is null) return Literal;
        var value = Expression.Evaluate(values);
        if (!BoundAttribute.ValidText(value, Source)) return Literal;
        if (!BoundAttribute.Present(value, kind, Source) || kind == BoundAttributeKind.Url && BoundAttribute.ExecutableUrl(value, Source)) return null;
        if (value.Type.Kind == "boolean" && kind != BoundAttributeKind.EnumeratedBoolean) return "";
        if (value.IsText) return (string)value.Data!;
        var counter = HtmlWriter.Counter(); BoundAttribute.RawText(ref counter, value, Source);
        return string.Create(counter.Length, (Value: value, Source), static (span, state) =>
        {
            var writer = new HtmlWriter(span); BoundAttribute.RawText(ref writer, state.Value, state.Source);
        });
    }
}

internal readonly record struct InvocationAttributeFrame(InvocationAttribute[] Attributes, Prop[] Props, object?[] Values);

internal sealed class InvocationAttributeState
{
    private readonly List<InvocationAttributeFrame> frames = [];
    private int start;

    public (int Start, int Count) Enter(InvocationAttribute[] attributes, Prop[] props, object?[] values, bool sharedRoot)
    {
        var previous = (start, frames.Count);
        if (!sharedRoot) start = frames.Count;
        frames.Add(new(attributes, props, values));
        return previous;
    }

    public void Leave((int Start, int Count) previous)
    {
        start = previous.Start;
        frames.RemoveRange(previous.Count, frames.Count - previous.Count);
    }

    private static bool Matches(string name, Prop prop) => HtmlNextCompiler.AsciiEquals(name, prop.Name) || HtmlNextCompiler.AsciiEquals(name, prop.AttributeName);

    private bool Consumed(string name, int owner)
    {
        for (var index = owner + 1; index < frames.Count; index++)
            foreach (var prop in frames[index].Props) if (Matches(name, prop)) return true;
        return false;
    }

    public string? Read(Prop[] props, int prop)
    {
        for (var index = start; index < frames.Count; index++)
            foreach (var attribute in frames[index].Attributes)
            {
                var receiving = -1;
                for (var candidate = 0; candidate < props.Length; candidate++)
                    if (Matches(attribute.Name, props[candidate])) { receiving = candidate; break; }
                if (receiving == prop && !Consumed(attribute.Name, index)) return attribute.Read(frames[index].Values);
            }
        return null;
    }

    public void Write(ref HtmlWriter writer, IReadOnlySet<string> owned, CancellationToken cancellation)
    {
        var current = CollectionsMarshal.AsSpan(frames);
        for (var index = current.Length - 1; index >= start; index--)
            foreach (var attribute in current[index].Attributes)
            {
                if (Consumed(attribute.Name, index)) continue;
                if (owned.Contains(attribute.Name)) throw ValueType.Error(attribute.Source, "Invocation attribute collisions are not implemented.");
                for (var other = index - 1; other >= start; other--)
                    foreach (var candidate in current[other].Attributes)
                        if (candidate.Name == attribute.Name) throw ValueType.Error(attribute.Source, "Delegated invocation attribute collisions are not implemented.");
                attribute.Write(ref writer, current[index].Values, cancellation);
            }
    }
}

internal sealed record ForwardedRootAttributes(IReadOnlySet<string> Owned) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => writer.Context?.WriteInvocationAttributes(ref writer, Owned, cancellation);
}
