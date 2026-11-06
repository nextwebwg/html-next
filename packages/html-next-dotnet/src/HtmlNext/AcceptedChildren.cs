namespace HtmlNext;

internal sealed class AcceptedChildFilter(string owner, string slot, string[] tags, HashSet<ComponentReference> targets, string source)
{
    public bool Matches(ComponentReference target) => targets.Contains(target);
    public string Source { get; } = source;
    public string Message(string tag) => $"'{owner}'s {(slot.Length == 0 ? "default" : "'" + slot + "'")} slot accepts {string.Join(", ", tags.Select(value => "'" + value + "'"))}; this {(tag == "#text" ? "text" : "<" + tag + ">")} is left out.";
}

internal sealed class AcceptedProjection
{
    private readonly List<AcceptedChildFilter> filters = [];
    private HashSet<(AcceptedChildFilter Filter, string Tag)>? warned;
    private int start;
    public bool Active => start < filters.Count;
    public int Enter(AcceptedChildFilter filter) { var previous = filters.Count; filters.Add(filter); return previous; }
    public void Leave(int previous) => filters.RemoveRange(previous, filters.Count - previous);
    public int Pause() { var previous = start; start = filters.Count; return previous; }
    public void Resume(int previous) => start = previous;

    public bool Accepts(ComponentReference? target, string? tag, RenderOperation[]? text, object?[] values, Action<HtmlNextDiagnostic>? report)
    {
        if (start == filters.Count) return true;
        if (tag is null && !TextPresent(text!, values)) return true;
        var accepted = true;
        for (var index = start; index < filters.Count; index++)
        {
            var filter = filters[index];
            if (target is not null && filter.Matches(target)) continue;
            accepted = false;
            if (report is not null && (warned ??= []).Add((filter, tag ?? "#text")))
                report(new("HNCS007", filter.Message(tag ?? "#text"), filter.Source));
        }
        return accepted;
    }

    private static bool TextPresent(RenderOperation[] body, object?[] values)
    {
        foreach (var operation in body)
        {
            var text = operation switch
            {
                Literal literal => literal.Text,
                TextValue value => ExpressionValue.Stored(value.Path.Read(values), value.Path.Type).ScalarText(),
                ExpressionText expression => expression.Expression.OutputStatus(values).ScalarText(),
                _ => "x",
            };
            if (text.Any(character => character is not (' ' or '\t' or '\n' or '\r' or '\f'))) return true;
        }
        return false;
    }
}
