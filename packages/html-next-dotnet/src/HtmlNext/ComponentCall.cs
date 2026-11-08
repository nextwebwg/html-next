using System.Runtime.InteropServices;

namespace HtmlNext;

internal sealed record ComponentArgument(ValueExpression? Expression, object? Constant, int Position = -1, string? Written = null);

internal sealed record ComponentCall(ComponentReference Target, ComponentArgument?[] Arguments, RenderOperation[] DeferredAttributes, RootStyle? ParentStyle = null, ProjectionGroup[]? Projection = null, bool SharedRoot = false, InvocationAttribute?[]? Attributes = null) : RenderOperation
{
    private readonly Prop[] props = Target.Props;
    internal AcceptedChildEntry ReadEntry(string[] accepts, object?[] caller, object?[] owner, RenderContext context, CancellationToken cancellation)
    {
        var frames = new List<ProjectionFrame>();
        return Read(this, caller);

        AcceptedChildEntry Read(ComponentCall call, object?[] parent)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(call.Target.Template.SourceName);
            var template = call.Target.Template;
            var child = template.BindInvocation(call.Arguments, parent, cancellation, context.OnDiagnostic, call.Attributes, context.InvocationAttributesFor(parent), call.Projection, context, initialize: false);
            var matched = accepts.Contains(template.Tag, StringComparer.Ordinal);
            var frame = new ProjectionFrame(call.Projection ?? [], parent, matched ? owner : child, template.Tag, call.SharedRoot);
            context.RecordCollectedInvocation(call, parent, child, frame.Claims);
            frames.Add(frame);
            if (matched) return new(new(call.Target.EntryType!, child), template.Tag, owner, frames.ToArray());
            var delegated = template.DelegatedInvocation ?? throw ValueType.Error(template.SourceName, "This accepted preset root is not implemented.");
            if (call.Target.ForwardsAttributes) context.CaptureInvocationAttributes(call.Attributes, call.props, parent, child);
            var previousFilter = context.PauseAcceptedProjection();
            var previousProjection = context.EnterMetadataProjection(frame);
            var previousAttributes = call.Target.ForwardsAttributes ? context.EnterInvocationAttributes(call.Attributes, call.props, parent, child) : null;
            try
            {
                template.PrepareEntryInvocation(child, parent, call.Projection, context, cancellation, context.OnDiagnostic);
                return Read(delegated, child);
            }
            finally
            {
                context.LeaveInvocationAttributes(previousAttributes);
                context.LeaveProjection(previousProjection);
                context.ResumeAcceptedProjection(previousFilter);
            }
        }
    }

    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (writer.Context?.AcceptsProjection(Target, Target.Template.Tag, null, values) == false) return;
        var previousFilter = writer.Context?.PauseAcceptedProjection() ?? -1;
        try
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
        finally { writer.Context?.ResumeAcceptedProjection(previousFilter); }
    }
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation) => context?.AcceptsProjection(Target, Target.Template.Tag, null, values) ?? true;
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (writer.Context?.AcceptsProjection(Target, Target.Template.Tag, null, values) == false) return;
        var previousFilter = writer.Context?.PauseAcceptedProjection() ?? -1;
        try
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(Target.Template.SourceName);
            var context = writer.Context!;
            var child = context.NextChild();
            if (child is null)
            {
                child = context.TakeCollectedInvocation(this, values);
                if (child is null) child = Target.Template.BindInvocation(Arguments, values, cancellation, context.OnDiagnostic, Attributes, context.InvocationAttributesFor(values), Projection, context);
                else Target.Template.InitializeInvocation(child, values, Projection, context, cancellation, context.OnDiagnostic);
                context.RecordChild(child);
            }
            var projected = Projection is { Length: > 0 } || SharedRoot && context.ProjectionFor(values) is not null;
            var previousProjection = projected ? context.EnterProjection(Projection ?? [], values, child, Target.Template.Tag, SharedRoot) : null;
            var previousAttributes = Target.ForwardsAttributes ? context.EnterInvocationAttributes(Attributes, props, values, child) : null;
            try
            {
                if (ParentStyle is null && !context.HasRootStyles) Target.Template.WritePlan(ref writer, child, cancellation);
                else
                {
                    var previous = context.EnterRootStyle(ParentStyle, values);
                    try { Target.Template.WritePlan(ref writer, child, cancellation); }
                    finally { context.LeaveRootStyle(previous); }
                }
                if (projected && context.ProjectionFor(child) is { CarrierHandled: false } frame && frame.NeedsCarrier(context, cancellation))
                    throw ValueType.Error(Target.Template.SourceName, "The rendered root has no position for its projection carrier.");
            }
            finally
            {
                context.LeaveInvocationAttributes(previousAttributes);
                if (projected) context.LeaveProjection(previousProjection);
            }
        }
        finally { writer.Context?.ResumeAcceptedProjection(previousFilter); }
    }
}

internal sealed record DeferredPropAttribute(string Name, ValueExpression Expression, ValueType Destination, BoundAttributeKind Kind, string Source, string? Fallback, int DeclarationContextSlot) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
        => BoundAttribute.Write(ref writer, Name, Read(values), Kind, Source, Fallback);

    public ExpressionValue Read(object?[] values)
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
        if (!ready) return ExpressionValue.Invalid;
        var conforms = value.IsNull || value.IsAbsent || (Destination.Kind switch
        {
            "object" or "list" => value.Type.Kind == Destination.Kind,
            _ => !Destination.CheckReference(value).IsInvalid,
        });
        return conforms ? value : ExpressionValue.Invalid;
    }
}

internal sealed class RenderContext(bool cacheChildren, Action<HtmlNextDiagnostic>? onDiagnostic, bool interactive = false, HtmlNextPrepareModule? prepareModule = null)
{
    private readonly ModulePreparationState? preparation = prepareModule is null ? null : new(prepareModule);
    public HtmlNextPrepareModule? PrepareModule => preparation?.Prepare;
    public PreparedModuleRecord? PreparedModule(InstanceInputs inputs) => preparation?.For(inputs);
    public void RecordPreparedModule(InstanceInputs inputs, PreparedModuleRecord record) => preparation!.Record(inputs, record);
    public string? SerializedModuleBindings(InstanceInputs inputs) => preparation?.Serialized(inputs);
    public void RecordModuleBindings(InstanceInputs inputs, string value) => preparation!.RecordSerialized(inputs, value);
    public bool Interactive { get; } = interactive;
    public bool Adopting { get; set; }
    private readonly List<object?[]>? children = cacheChildren ? [] : null;
    private int position = -1;
    private List<RootStyleFrame>? rootStyles;
    private int rootStyleStart;
    private ProjectionState? projections;
    private InvocationAttributeState? invocationAttributes;
    private Dictionary<string, string?>? attributeOutput;
    private Dictionary<string, string?>? forwardedAttributeOutput;
    public Dictionary<string, string?> AttributeOutput()
    {
        var output = attributeOutput ??= new(StringComparer.Ordinal);
        output.Clear();
        return output;
    }
    public Dictionary<string, string?> ForwardedAttributeOutput()
    {
        var output = forwardedAttributeOutput ??= new(StringComparer.Ordinal);
        output.Clear();
        return output;
    }
    private AcceptedChildContext ChildLists => (projections ??= new(children is not null)).ChildLists ??= new();
    public object?[] CaptureScope(object?[] values) => ChildLists.CaptureScope(values);
    private object?[] ScopeOwner(object?[] values) => projections?.ChildLists?.ScopeOwner(values) ?? values;
    public void RecordEntry(AcceptedChildEntry entry) => ChildLists.RecordEntry(entry);
    public void RecordPreparedInvocation(object?[] values) => ChildLists.RecordPreparedInvocation(values);
    public bool TakePreparedInvocation(object?[] values) => projections?.ChildLists?.TakePreparedInvocation(values) == true;
    public void RecordCollectedInvocation(ComponentCall call, object?[] caller, object?[] child, bool[] claims) => ChildLists.RecordCollectedInvocation(call, caller, child, claims);
    public object?[]? TakeCollectedInvocation(ComponentCall call, object?[] caller) => projections?.ChildLists?.TakeCollectedInvocation(call, caller);
    public AcceptedChildEntry? Entry(ExpressionValue value, object?[] owner) => projections?.ChildLists?.Entry(value, owner);
    public ProjectionFrame? EnterBorrowedProjection(AcceptedChildEntry entry)
    {
        projections ??= new(children is not null);
        var previous = projections.Current;
        entry.Attach(previous);
        projections.Current = entry.Frame;
        return previous;
    }
    public ProjectionFrame? EnterMetadataProjection(ProjectionFrame frame)
    {
        projections ??= new(children is not null);
        var previous = projections.Current;
        frame.Attach(previous);
        projections.Current = frame;
        return previous;
    }
    public bool HasAcceptedProjection => projections?.Accepted?.Active == true;
    public int EnterAcceptedProjection(AcceptedChildFilter? filter) => filter is null ? -1 : ((projections ??= new(children is not null)).Accepted ??= new()).Enter(filter);
    public void LeaveAcceptedProjection(int previous) { if (previous >= 0) projections!.Accepted!.Leave(previous); }
    public int PauseAcceptedProjection() => projections?.Accepted?.Pause() ?? -1;
    public void ResumeAcceptedProjection(int previous) { if (previous >= 0) projections!.Accepted!.Resume(previous); }
    public bool AcceptsProjection(ComponentReference? target, string? tag, RenderOperation[]? text, object?[] values) => projections?.Accepted?.Accepts(target, tag, text, values, OnDiagnostic) ?? true;
    public InvocationAttributeFrame? InvocationAttributesFor(object?[] values)
    {
        var owner = ScopeOwner(values);
        return invocationAttributes?.Find(owner) ?? projections?.ChildLists?.InvocationAttributesFor(owner);
    }
    public void CaptureInvocationAttributes(InvocationAttribute?[]? attributes, Prop[] props, object?[] caller, object?[] receiver)
    {
        var parent = projections?.ChildLists?.InvocationAttributesFor(ScopeOwner(caller)) ?? InvocationAttributesFor(caller);
        ChildLists.RecordInvocationAttributes(new(attributes ?? [], props, caller, receiver, parent));
    }
    public int? EnterInvocationAttributes(InvocationAttribute?[]? attributes, Prop[] props, object?[] caller, object?[] receiver)
    {
        if (attributes is null && invocationAttributes is null) return null;
        return (invocationAttributes ??= new()).Enter(attributes ?? [], props, caller, receiver, InvocationAttributesFor(caller));
    }
    public void LeaveInvocationAttributes(int? previous)
    {
        if (previous is { } frame) invocationAttributes!.Leave(frame);
    }
    public ProjectionFrame? EnterProjection(ProjectionGroup[] groups, object?[] caller, object?[] receiver, string tag, bool sharedRoot) =>
        (projections ??= new(children is not null)).Enter(groups, caller, receiver, tag, sharedRoot,
            projections?.ChildLists?.ProjectionClaims(receiver));
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
    public ProjectionFrame? ProjectionFor(object?[] values) => projections?.Find(ScopeOwner(values));
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
    public void Replay() { position = 0; projections?.Replay(); projections?.ChildLists?.Replay(); }
}

internal readonly record struct RootStyleFrame(RootStyle Style, object?[] Values);
