namespace HtmlNext;

internal sealed record ProjectionNode(RenderOperation[] Body, string? Tag = null) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation) => context?.AcceptsProjection(null, Tag, Body, values) ?? true;
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (writer.Context?.AcceptsProjection(null, Tag, Body, values) == false) return;
        foreach (var operation in Body) operation.Write(ref writer, values, cancellation);
    }
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (writer.Context?.AcceptsProjection(null, Tag, Body, values) == false) return;
        foreach (var operation in Body) operation.WriteDeferred(ref writer, values, cancellation);
    }
}

internal sealed record ProjectionGroup(string Name, bool Template, RenderOperation[] Body, ValueExpression? Guard = null, string? Source = null, ScopedSlotLocal[]? Locals = null, AcceptedChildFilter? Filter = null)
{
    public bool HasNodes(object?[] caller, RenderContext? context, CancellationToken cancellation)
    {
        var previous = context?.EnterAcceptedProjection(Filter) ?? -1;
        try { return RenderOperation.AnyNodes(Body, caller, context, cancellation); }
        finally { context?.LeaveAcceptedProjection(previous); }
    }
    public void Write(ref HtmlWriter writer, object?[] caller, CancellationToken cancellation, bool deferred)
    {
        var previous = writer.Context?.EnterAcceptedProjection(Filter) ?? -1;
        try
        {
            foreach (var operation in Body)
                if (deferred) operation.WriteDeferred(ref writer, caller, cancellation); else operation.Write(ref writer, caller, cancellation);
        }
        finally { writer.Context?.LeaveAcceptedProjection(previous); }
    }
    public void RejectTemplate(object?[] caller, RenderContext? context)
    {
        if (Guard is not null && !Guard.Evaluate(caller).Truthy) return;
        var previous = context?.EnterAcceptedProjection(Filter) ?? -1;
        try { context?.AcceptsProjection(null, "template", null, caller); }
        finally { context?.LeaveAcceptedProjection(previous); }
    }
}

internal sealed class ProjectionFrame(ProjectionGroup[] groups, object?[] caller, object?[] receiver, string tag, bool sharedRoot, bool[]? claims = null)
{
    private readonly bool[] used = claims ?? new bool[groups.Length];
    private readonly bool ownsClaims = claims is null;
    public bool[] Claims => used;
    public ProjectionGroup[] Groups { get; } = groups;
    public object?[] Caller { get; } = caller;
    public object?[] Receiver { get; } = receiver;
    public ProjectionFrame? Parent { get; private set; }
    public bool CarrierHandled { get; private set; }
    public bool NeedsCarrier(RenderContext? context, CancellationToken cancellation)
    {
        for (var index = 0; index < Groups.Length; index++)
        {
            var group = Groups[index];
            if (group.Template)
            {
                if (group.Filter is null) return true;
                group.RejectTemplate(Caller, context);
            }
            else if (!used[index] && (group.Filter is null || group.HasNodes(Caller, context, cancellation))) return true;
        }
        return false;
    }
    public void Attach(ProjectionFrame? parent) => Parent = parent;
    public void Reset(ProjectionFrame? parent) { if (ownsClaims) Array.Clear(used); Parent = parent; CarrierHandled = false; }

    public void WriteCarriers(ref HtmlWriter writer, CancellationToken cancellation)
    {
        if (CarrierHandled) return;
        cancellation.ThrowIfCancellationRequested();
        if (sharedRoot) Parent?.WriteCarriers(ref writer, cancellation);
        CarrierHandled = true;
        if (!NeedsCarrier(writer.Context, cancellation)) return;
        writer.Write("<template carrier=\""); writer.Write(tag); writer.Write("\">");
        for (var index = 0; index < Groups.Length; index++)
        {
            var group = Groups[index];
            if (group.Template && group.Filter is null) writer.Write(group.Source);
            else if (group.Template) group.RejectTemplate(Caller, writer.Context);
            else if (!used[index]) group.Write(ref writer, Caller, cancellation, true);
        }
        writer.Write("</template>");
    }

    public int Template(string name, RenderContext? context)
    {
        for (var index = 0; index < Groups.Length; index++)
        {
            var group = Groups[index];
            if (group.Name != name || !group.Template || group.Guard is not null && !group.Guard.Evaluate(Caller).Truthy) continue;
            if (group.Filter is null) return index;
            group.RejectTemplate(Caller, context);
        }
        return -1;
    }

    public bool Assigned(string name, RenderContext? context, CancellationToken cancellation)
    {
        for (var index = 0; index < Groups.Length; index++)
            if (Groups[index].Name == name && used[index]) return false;
        foreach (var group in Groups)
            if (group.Name == name && !group.Template && group.HasNodes(Caller, context, cancellation)) return true;
        return false;
    }

    public void Claim(string name)
    {
        for (var index = 0; index < Groups.Length; index++) if (Groups[index].Name == name && !Groups[index].Template) used[index] = true;
    }
}

internal sealed class ProjectionState(bool cache)
{
    private readonly List<ProjectionFrame>? frames = cache ? [] : null;
    private int position;
    public ProjectionFrame? Current { get; set; }
    public AcceptedProjection? Accepted { get; set; }
    public AcceptedChildContext? ChildLists
    {
        get => Accepted?.ChildLists;
        set => (Accepted ??= new()).ChildLists = value;
    }
    public ProjectionFrame? Enter(ProjectionGroup[] groups, object?[] caller, object?[] receiver, string tag, bool sharedRoot, bool[]? claims = null)
    {
        var previous = Current;
        var frame = frames is not null && position < frames.Count ? frames[position] : new ProjectionFrame(groups, caller, receiver, tag, sharedRoot, claims);
        if (frames is not null && position == frames.Count) frames.Add(frame);
        position++;
        frame.Reset(previous);
        Current = frame;
        return previous;
    }
    public void Replay() { position = 0; Current = null; }
    public ProjectionFrame? Find(object?[] values)
    {
        for (var frame = Current; frame is not null; frame = frame.Parent)
            if (ReferenceEquals(frame.Receiver, values)) return frame;
        return null;
    }
}

internal sealed record ProjectionRootEnd(string Closing) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        writer.Context?.ProjectionFor(values)?.WriteCarriers(ref writer, cancellation);
        writer.Write(Closing);
    }
}

internal sealed record SlotOutlet(string Name, RenderOperation[] Fallback, ScopedSlotArguments? Inputs = null) : RenderOperation
{
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WritePlacement(ref writer, values, cancellation, true);
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation)
    {
        var frame = context?.ProjectionFor(values);
        if (frame is not null)
        {
            var template = frame.Template(Name, context);
            if (template >= 0)
            {
                var group = frame.Groups[template];
                if (group.Locals is null || Inputs is null) return AnyNodes(group.Body, frame.Caller, context, cancellation);
                var snapshot = Inputs.Bind(values, context, cancellation, true);
                ScopedSlotArguments.Enter(group.Locals, frame.Caller, snapshot);
                try { return AnyNodes(group.Body, frame.Caller, context, cancellation); }
                finally { ScopedSlotArguments.Leave(group.Locals, frame.Caller, snapshot); }
            }
            if (frame.Assigned(Name, context, cancellation))
            {
                RequireTemplate();
                return true;
            }
            if (context!.HasAcceptedProjection) frame.Claim(Name);
        }
        return AnyNodes(Fallback, values, context, cancellation);
    }

    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WritePlacement(ref writer, values, cancellation, false);

    private void RequireTemplate()
    {
        if (Inputs?.ExposesProps == true) throw ValueType.Error(Inputs.Source, $"Scoped slot '{Name}' requires a consumer <template slot=\"{Name}\">.");
    }

    internal void WriteMissing(ref HtmlWriter writer, object?[] values, CancellationToken cancellation, bool deferred) => WritePlacement(ref writer, values, cancellation, deferred, true, -1);

    internal void WriteBorrowed(ref HtmlWriter writer, object?[] values, CancellationToken cancellation, bool deferred, int index) => WritePlacement(ref writer, values, cancellation, deferred, borrowed: index);

    private void WritePlacement(ref HtmlWriter writer, object?[] values, CancellationToken cancellation, bool deferred, bool missing = false, int? borrowed = null)
    {
        cancellation.ThrowIfCancellationRequested();
        var frame = missing ? null : writer.Context?.ProjectionFor(values);
        var template = frame?.Template(Name, writer.Context) ?? -1;
        var assigned = template >= 0 || frame?.Assigned(Name, writer.Context, cancellation) == true;
        if (template < 0 && assigned) RequireTemplate();
        if (template < 0 && !deferred) frame?.Claim(Name);
        var body = template >= 0 ? frame!.Groups[template].Body : Fallback;
        var locals = template >= 0 ? frame!.Groups[template].Locals : null;
        object?[]? snapshot = null;
        if (locals is not null && Inputs is not null)
        {
            snapshot = writer.Context?.NextChild();
            if (snapshot is null)
            {
                snapshot = Inputs.Bind(values, writer.Context, cancellation, false);
                writer.Context?.RecordChild(snapshot);
            }
            ScopedSlotArguments.Enter(locals, frame!.Caller, snapshot);
        }
        try
        {
            if ((!assigned || template >= 0) && body.Length == 0 && borrowed is null)
            {
                writer.Write("<?marker slot=\""); writer.Write(Name); writer.Write("\"?>");
                return;
            }
            writer.Write("<?start slot=\""); writer.Write(Name); writer.Write('"');
            if (borrowed is { } index)
            {
                writer.Write(" of=\"");
                if (index >= 0) HtmlOutput.Number(ref writer, index);
                writer.Write('"');
            }
            if (!assigned) writer.Write(" fallback=\"\"");
            if (template >= 0 || Inputs?.ExposesProps == true) writer.Write(" scoped=\"\"");
            writer.Write("?>");
            if (assigned && template < 0)
            {
                if (!deferred) foreach (var group in frame!.Groups)
                    if (group.Name == Name && !group.Template) group.Write(ref writer, frame.Caller, cancellation, false);
            }
            else foreach (var operation in body)
            {
                if (deferred) operation.WriteDeferred(ref writer, template >= 0 ? frame!.Caller : values, cancellation);
                else operation.Write(ref writer, template >= 0 ? frame!.Caller : values, cancellation);
            }
            writer.Write("<?end?>");
        }
        finally { if (snapshot is not null) ScopedSlotArguments.Leave(locals!, frame!.Caller, snapshot); }
    }
}
