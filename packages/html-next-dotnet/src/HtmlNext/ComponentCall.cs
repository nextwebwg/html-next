using System.Runtime.InteropServices;

namespace HtmlNext;

internal sealed record ComponentArgument(ValueExpression? Expression, object? Constant);

internal sealed record ComponentCall(ComponentReference Target, ComponentArgument?[] Arguments, RenderOperation[] DeferredAttributes, RootStyle? ParentStyle = null, ProjectionGroup[]? Projection = null, bool SharedRoot = false) : RenderOperation
{
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        ExecutionStack.Check(Target.Template.SourceName);
        writer.Write('<'); writer.Write(Target.Template.Tag);
        foreach (var operation in DeferredAttributes) operation.Write(ref writer, values, cancellation);
        writer.Write('>');
        if (Projection is not null) foreach (var group in Projection)
        {
            if (group.Template) writer.Write(group.Source);
            else foreach (var operation in group.Body) operation.WriteDeferred(ref writer, values, cancellation);
        }
        writer.Write("</"); writer.Write(Target.Template.Tag); writer.Write('>');
    }
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation) => true;
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        ExecutionStack.Check(Target.Template.SourceName);
        var context = writer.Context!;
        var child = context.NextChild();
        if (child is null)
        {
            child = Target.Template.BindInvocation(Arguments, values, cancellation, context.OnDiagnostic);
            context.RecordChild(child);
        }
        var projected = Projection is { Length: > 0 } || SharedRoot && context.ProjectionFor(values) is not null;
        var previousProjection = projected ? context.EnterProjection(Projection ?? [], values, child, Target.Template.Tag, SharedRoot) : null;
        try
        {
            if (ParentStyle is null && !context.HasRootStyles) Target.Template.WritePlan(ref writer, child, cancellation);
            else
            {
                var previous = context.EnterRootStyle(ParentStyle, values);
                try { Target.Template.WritePlan(ref writer, child, cancellation); }
                finally { context.LeaveRootStyle(previous); }
            }
            if (projected && context.ProjectionFor(child) is { CarrierHandled: false, NeedsCarrier: true })
                throw ValueType.Error(Target.Template.SourceName, "The rendered root has no position for its projection carrier.");
        }
        finally { if (projected) context.LeaveProjection(previousProjection); }
    }
}

internal sealed record DeferredPropAttribute(string Name, ValueExpression Expression, ValueType Destination, BoundAttributeKind Kind, string Source, string? Fallback, int DeclarationContextSlot) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        var evaluation = DeclarationContextSlot < 0 ? null : (DeclarationEvaluation)values[DeclarationContextSlot]!;
        var previousReady = evaluation?.Ready ?? true;
        if (evaluation is not null) evaluation.Ready = true;
        ExpressionValue value;
        bool ready;
        try
        {
            value = Expression.Evaluate(values);
            ready = evaluation?.Ready ?? true;
        }
        finally { if (evaluation is not null) evaluation.Ready = previousReady; }
        if (!ready) { writer.Write(Fallback); return; }
        var conforms = value.IsNull || value.IsAbsent || (Destination.Kind switch
        {
            "object" or "list" => value.Type.Kind == Destination.Kind,
            _ => !Destination.CheckReference(value).IsInvalid,
        });
        if (!conforms) { writer.Write(Fallback); return; }
        BoundAttribute.Write(ref writer, Name, value, Kind, Source, Fallback);
    }
}

internal sealed class RenderContext(bool cacheChildren, Action<HtmlNextDiagnostic>? onDiagnostic)
{
    private readonly List<object?[]>? children = cacheChildren ? [] : null;
    private int position = -1;
    private List<RootStyleFrame>? rootStyles;
    private int rootStyleStart;
    private ProjectionState? projections;
    public ProjectionFrame? EnterProjection(ProjectionGroup[] groups, object?[] caller, object?[] receiver, string tag, bool sharedRoot) =>
        (projections ??= new(children is not null)).Enter(groups, caller, receiver, tag, sharedRoot);
    public void WarnSlot(ScopedSlotArguments outlet, int prop)
    {
        if (OnDiagnostic is null) return;
        if (OnDiagnostic.Target is not ScopedSlotWarnings warnings)
        {
            warnings = new(OnDiagnostic);
            OnDiagnostic = warnings.Report;
        }
        if (warnings.Warn(outlet, prop)) OnDiagnostic(new("HNCS004", $"Slot '{outlet.Contract.Name}' prop '{outlet.Contract.Props[prop].Definition.Name}' does not satisfy its declared type.", outlet.Source));
    }
    public void LeaveProjection(ProjectionFrame? previous) => projections!.Current = previous;
    public ProjectionFrame? ProjectionFor(object?[] values) => projections?.Find(values);
    public bool HasRootStyles => rootStyles?.Count > rootStyleStart;
    public ReadOnlySpan<RootStyleFrame> RootStyles() => rootStyles is null ? [] : CollectionsMarshal.AsSpan(rootStyles)[rootStyleStart..];
    public (int Start, int Count) EnterRootStyle(RootStyle? style, object?[] values)
    {
        var previous = (rootStyleStart, rootStyles?.Count ?? 0);
        if (style is null) rootStyleStart = previous.Item2;
        else (rootStyles ??= []).Add(new(style, values));
        return previous;
    }
    public void LeaveRootStyle((int Start, int Count) previous)
    {
        rootStyleStart = previous.Start;
        if (rootStyles is not null && rootStyles.Count > previous.Count) rootStyles.RemoveRange(previous.Count, rootStyles.Count - previous.Count);
    }
    public Action<HtmlNextDiagnostic>? OnDiagnostic { get; private set; } = onDiagnostic;
    public object?[]? NextChild() => position >= 0 ? children![position++] : null;
    public void RecordChild(object?[] values) => children?.Add(values);
    public void Replay() { position = 0; projections?.Replay(); }
}

internal readonly record struct RootStyleFrame(RootStyle Style, object?[] Values);
