namespace HtmlNext;

internal sealed record AcceptedChildListBinding(string Name, int Slot, ValueType Type, string[] Accepts);

internal static class AcceptedChildLists
{
    public static ExpressionValue Read(AcceptedChildListBinding binding, ProjectionGroup[] groups, object?[] caller, object?[] receiver, RenderContext? context, CancellationToken cancellation)
    {
        var entries = new List<object?>();
        foreach (var group in groups)
        {
            if (group.Name != binding.Name || group.Template) continue;
            var previous = context?.EnterAcceptedProjection(group.Filter) ?? -1;
            try { foreach (var operation in group.Body) Collect(operation, caller, receiver, context, cancellation, entries, binding.Accepts); }
            finally { context?.LeaveAcceptedProjection(previous); }
        }
        return new(binding.Type, entries.ToArray());
    }

    private static void Collect(RenderOperation operation, object?[] caller, object?[] receiver, RenderContext? context, CancellationToken cancellation, List<object?> entries, string[] accepts, bool capture = false)
    {
        cancellation.ThrowIfCancellationRequested();
        switch (operation)
        {
            case HydrationRegion region:
                foreach (var child in region.Body) Collect(child, caller, receiver, context, cancellation, entries, accepts, capture);
                break;
            case ComponentCall call:
                if (context?.AcceptsProjection(call.Target, call.Target.Template.Tag, null, caller) != false)
                {
                    var entry = call.ReadEntry(accepts, capture && context is not null ? context.CaptureScope(caller) : caller, receiver, context!, cancellation);
                    context!.RecordEntry(entry);
                    entries.Add(entry.Value);
                }
                break;
            case ProjectionNode { Tag: null } node:
                foreach (var child in node.Body) Collect(child, caller, receiver, context, cancellation, entries, accepts, capture);
                break;
            case ProjectionNode: break;
            case ScopedValue alias:
                alias.Visit(caller, () =>
                {
                    foreach (var child in alias.Body) Collect(child, caller, receiver, context, cancellation, entries, accepts, true);
                });
                break;
            case MatchChoice match:
                if (match.SelectBody(caller) is { } selected)
                    foreach (var child in selected) Collect(child, caller, receiver, context, cancellation, entries, accepts, capture);
                break;
            case Conditional condition:
                if (condition.Path.Read(caller) is true)
                    foreach (var child in condition.Body) Collect(child, caller, receiver, context, cancellation, entries, accepts, capture);
                break;
            case ExpressionConditional condition:
                if (condition.Expression.Evaluate(caller).Truthy)
                    foreach (var child in condition.Body) Collect(child, caller, receiver, context, cancellation, entries, accepts, capture);
                break;
            case PlannedEach each:
                each.Visit(caller, cancellation, () =>
                {
                    foreach (var child in each.Body) Collect(child, caller, receiver, context, cancellation, entries, accepts, true);
                });
                break;
            case Each each:
                each.Visit(caller, cancellation, () =>
                {
                    foreach (var child in each.Body) Collect(child, caller, receiver, context, cancellation, entries, accepts, true);
                });
                break;
            case ExpressionEach each:
                each.Visit(caller, cancellation, () =>
                {
                    foreach (var child in each.Body) Collect(child, caller, receiver, context, cancellation, entries, accepts, true);
                });
                break;
            case Literal or TextValue or ExpressionText: break;
            default: throw ValueType.Error("<projection>", "This structural operation in an as list is not implemented.");
        }
    }
}
