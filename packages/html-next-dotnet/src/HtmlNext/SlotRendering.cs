namespace HtmlNext;

internal sealed record ProjectionNode(RenderOperation[] Body) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation) => true;
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        foreach (var operation in Body) operation.Write(ref writer, values, cancellation);
    }
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        foreach (var operation in Body) operation.WriteDeferred(ref writer, values, cancellation);
    }
}

internal sealed record ProjectionGroup(string Name, bool Template, RenderOperation[] Body, ValueExpression? Guard = null, string? Source = null, ScopedSlotLocal[]? Locals = null);

internal sealed class ProjectionFrame(ProjectionGroup[] groups, object?[] caller, object?[] receiver, string tag, bool sharedRoot)
{
    private readonly bool[] used = new bool[groups.Length];
    public ProjectionGroup[] Groups { get; } = groups;
    public object?[] Caller { get; } = caller;
    public object?[] Receiver { get; } = receiver;
    public ProjectionFrame? Parent { get; private set; }
    public bool CarrierHandled { get; private set; }
    public bool NeedsCarrier
    {
        get
        {
            for (var index = 0; index < Groups.Length; index++) if (Groups[index].Template || !used[index]) return true;
            return false;
        }
    }
    public void Reset(ProjectionFrame? parent) { Array.Clear(used); Parent = parent; CarrierHandled = false; }

    public void WriteCarriers(ref HtmlWriter writer, CancellationToken cancellation)
    {
        if (CarrierHandled) return;
        cancellation.ThrowIfCancellationRequested();
        if (sharedRoot) Parent?.WriteCarriers(ref writer, cancellation);
        CarrierHandled = true;
        if (!NeedsCarrier) return;
        writer.Write("<template carrier=\""); writer.Write(tag); writer.Write("\">");
        for (var index = 0; index < Groups.Length; index++)
        {
            var group = Groups[index];
            if (group.Template) writer.Write(group.Source);
            else if (!used[index]) foreach (var operation in group.Body) operation.WriteDeferred(ref writer, Caller, cancellation);
        }
        writer.Write("</template>");
    }

    public int Template(string name)
    {
        for (var index = 0; index < Groups.Length; index++)
        {
            var group = Groups[index];
            if (group.Name == name && group.Template && (group.Guard is null || group.Guard.Evaluate(Caller).Truthy)) return index;
        }
        return -1;
    }

    public bool Assigned(string name, RenderContext? context, CancellationToken cancellation)
    {
        for (var index = 0; index < Groups.Length; index++)
            if (Groups[index].Name == name && used[index]) return false;
        foreach (var group in Groups)
            if (group.Name == name && !group.Template && RenderOperation.AnyNodes(group.Body, Caller, context, cancellation)) return true;
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
    public ProjectionFrame? Enter(ProjectionGroup[] groups, object?[] caller, object?[] receiver, string tag, bool sharedRoot)
    {
        var previous = Current;
        var frame = frames is not null && position < frames.Count ? frames[position] : new ProjectionFrame(groups, caller, receiver, tag, sharedRoot);
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
            var template = frame.Template(Name);
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
        }
        return AnyNodes(Fallback, values, context, cancellation);
    }

    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WritePlacement(ref writer, values, cancellation, false);

    private void RequireTemplate()
    {
        if (Inputs?.ExposesProps == true) throw ValueType.Error(Inputs.Source, $"Scoped slot '{Name}' requires a consumer <template slot=\"{Name}\">.");
    }

    private void WritePlacement(ref HtmlWriter writer, object?[] values, CancellationToken cancellation, bool deferred)
    {
        cancellation.ThrowIfCancellationRequested();
        var frame = writer.Context?.ProjectionFor(values);
        var template = frame?.Template(Name) ?? -1;
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
            if ((!assigned || template >= 0) && body.Length == 0)
            {
                writer.Write("<?marker slot=\""); writer.Write(Name); writer.Write("\"?>");
                return;
            }
            writer.Write("<?start slot=\""); writer.Write(Name); writer.Write('"');
            if (!assigned) writer.Write(" fallback=\"\"");
            if (template >= 0 || Inputs?.ExposesProps == true) writer.Write(" scoped=\"\"");
            writer.Write("?>");
            if (assigned && template < 0)
            {
                if (!deferred) foreach (var group in frame!.Groups)
                    if (group.Name == Name && !group.Template) foreach (var operation in group.Body) operation.Write(ref writer, frame.Caller, cancellation);
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
