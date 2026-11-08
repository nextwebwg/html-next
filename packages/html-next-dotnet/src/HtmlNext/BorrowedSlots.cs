namespace HtmlNext;

internal sealed class AcceptedChildEntry(ExpressionValue value, string tag, object?[] owner, ProjectionFrame[] frames)
{
    public ExpressionValue Value => new(value.Type, this);
    public string Tag { get; } = tag;
    public ValueType Type => value.Type;
    public object?[] Child { get; } = (object?[])value.Data!;
    public object?[] Owner { get; } = owner;
    public ProjectionFrame Frame => frames[^1];
    public void Attach(ProjectionFrame? parent)
    {
        for (var index = 0; index < frames.Length; index++) frames[index].Attach(index == 0 ? parent : frames[index - 1]);
    }
    public void Reset()
    {
        for (var index = 0; index < frames.Length; index++) frames[index].Reset(index == 0 ? null : frames[index - 1]);
    }
}

internal sealed record BorrowedSlotOutlet(ValueExpression Of, IReadOnlyDictionary<string, SlotOutlet> Outlets, SlotOutlet Missing, string Source) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation)
    {
        var value = Of.Evaluate(values);
        if (value.IsNull || value.IsAbsent) return AnyNodes(Missing.Fallback, values, context, cancellation);
        var entry = context?.Entry(value, values) ?? throw ValueType.Error(Source, "of requires an entry of this component's own as list.");
        var previous = context!.EnterBorrowedProjection(entry);
        try { return Outlet(entry).HasNodes(values, context, cancellation); }
        finally { context.LeaveProjection(previous); }
    }

    private SlotOutlet Outlet(AcceptedChildEntry entry) => Outlets.TryGetValue(entry.Tag, out var outlet) ? outlet
        : throw ValueType.Error(Source, "This accepted child's delegated slot is not implemented.");

    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WritePlacement(ref writer, values, cancellation, false);
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WritePlacement(ref writer, values, cancellation, true);

    private void WritePlacement(ref HtmlWriter writer, object?[] values, CancellationToken cancellation, bool deferred)
    {
        var value = Of.Evaluate(values);
        if (value.IsNull || value.IsAbsent)
        {
            Missing.WriteMissing(ref writer, values, cancellation, deferred);
            return;
        }
        var context = writer.Context ?? throw ValueType.Error(Source, "of requires a component render context.");
        var entry = context.Entry(value, values) ?? throw ValueType.Error(Source, "of requires an entry of this component's own as list.");
        var previous = context.EnterBorrowedProjection(entry);
        try
        {
            var outlet = Outlet(entry);
            if (deferred) outlet.WriteDeferred(ref writer, values, cancellation); else outlet.Write(ref writer, values, cancellation);
        }
        finally { context.LeaveProjection(previous); }
    }
}
