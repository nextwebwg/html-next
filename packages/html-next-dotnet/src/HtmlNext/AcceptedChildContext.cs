namespace HtmlNext;

internal sealed class AcceptedChildContext
{
    private Dictionary<object?[], AcceptedChildEntry>? entries;
    private Dictionary<ComponentCall, Dictionary<object?[], Queue<object?[]>>>? collectedInvocations;
    private Dictionary<object?[], object?[]>? capturedScopes;
    private HashSet<object?[]>? preparedInvocations;
    private Dictionary<object?[], bool[]>? collectedProjectionClaims;
    private Dictionary<object?[], InvocationAttributeFrame>? invocationAttributes;
    public object?[] CaptureScope(object?[] values)
    {
        var captured = (object?[])values.Clone();
        for (var index = 0; index < captured.Length; index++)
            if (captured[index] is IterationIndex iteration) captured[index] = new IterationIndex { Value = iteration.Value };
        (capturedScopes ??= []).Add(captured, ScopeOwner(values));
        return captured;
    }
    public object?[] ScopeOwner(object?[] values) => capturedScopes?.TryGetValue(values, out var owner) == true ? owner : values;
    public void RecordEntry(AcceptedChildEntry entry) => (entries ??= []).Add(entry.Child, entry);
    public void RecordPreparedInvocation(object?[] values) => (preparedInvocations ??= []).Add(values);
    public bool TakePreparedInvocation(object?[] values) => preparedInvocations?.Remove(values) == true;
    public void RecordCollectedInvocation(ComponentCall call, object?[] caller, object?[] child, bool[] claims)
    {
        (collectedProjectionClaims ??= []).Add(child, claims);
        collectedInvocations ??= new(ReferenceEqualityComparer.Instance);
        if (!collectedInvocations.TryGetValue(call, out var callers)) collectedInvocations.Add(call, callers = []);
        caller = ScopeOwner(caller);
        if (!callers.TryGetValue(caller, out var children)) callers.Add(caller, children = new());
        children.Enqueue(child);
    }
    public object?[]? TakeCollectedInvocation(ComponentCall call, object?[] caller) =>
        collectedInvocations?.TryGetValue(call, out var callers) == true && callers.TryGetValue(ScopeOwner(caller), out var children) && children.TryDequeue(out var child) ? child : null;
    public AcceptedChildEntry? Entry(ExpressionValue value, object?[] owner) =>
        value.Data is AcceptedChildEntry candidate && entries?.TryGetValue(candidate.Child, out var entry) == true
        && ReferenceEquals(candidate, entry) && ReferenceEquals(entry.Owner, ScopeOwner(owner)) ? entry : null;
    public bool[]? ProjectionClaims(object?[] values) => collectedProjectionClaims?.GetValueOrDefault(values);
    public void RecordInvocationAttributes(InvocationAttributeFrame frame) => (invocationAttributes ??= []).Add(frame.Receiver, frame);
    public InvocationAttributeFrame? InvocationAttributesFor(object?[] values) => invocationAttributes?.GetValueOrDefault(values);
    public void Replay() { if (entries is not null) foreach (var entry in entries.Values) entry.Reset(); }
}
