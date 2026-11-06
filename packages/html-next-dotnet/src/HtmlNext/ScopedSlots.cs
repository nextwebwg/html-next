namespace HtmlNext;

internal sealed record ScopedSlotProp(Prop Definition, bool HasDefault);
internal sealed record ScopedSlotContract(string Name, ScopedSlotProp[] Props);
internal sealed record ScopedSlotLocal(int Slot, int Prop);

internal sealed record ScopedSlotValue(int Slot, ValueType Declared, ValueExpression? Outer, ValueType Result) : ValueExpression(Result)
{
    public override ExpressionValue Evaluate(object?[] values) => ReferenceEquals(values[Slot], ExpressionValue.AbsentStorage)
        ? Outer?.Evaluate(values) ?? ExpressionValue.Absent : ExpressionValue.Stored(values[Slot], Declared);
}

internal sealed class ProjectionExpressionScope(Dictionary<string, (int Slot, ValueType Type)> values, IReadOnlyDictionary<int, ScopedSlotValue> locals) : IDeclarationExpressionScope
{
    public (int Slot, ValueType Type) this[string key] => values[key];
    public IEnumerable<string> Keys => values.Keys;
    public IEnumerable<(int Slot, ValueType Type)> Values => values.Values;
    public int Count => values.Count;
    public bool ContainsKey(string key) => values.ContainsKey(key);
    public bool TryGetValue(string key, out (int Slot, ValueType Type) value) => values.TryGetValue(key, out value);
    public ValueExpression Read(string name, int slot, ValueType type) => locals.TryGetValue(slot, out var local) ? local
        : new PathExpression(new(slot, [], type, RootType: type.Reference ? type : null));
    public IEnumerator<KeyValuePair<string, (int Slot, ValueType Type)>> GetEnumerator() => values.GetEnumerator();
    System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}

internal sealed record ScopedSlotArguments(ScopedSlotContract Contract, ComponentArgument?[] Arguments, string Source)
{
    public bool ExposesProps { get; } = Arguments.Where((argument, index) => argument is not null || Contract.Props[index].HasDefault).Any();

    public object?[] Bind(object?[] values, RenderContext? context, CancellationToken cancellation, bool preview)
    {
        var snapshot = new object?[Contract.Props.Length * 2];
        for (var index = 0; index < Contract.Props.Length; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            var entry = Contract.Props[index];
            var prop = entry.Definition;
            var argument = Arguments[index];
            snapshot[index] = argument is null && !entry.HasDefault ? ExpressionValue.AbsentStorage : prop.Default;
            if (argument?.Expression is { } expression)
            {
                var input = expression.Evaluate(values);
                if (input.IsInvalid || input.IsNull || input.IsAbsent) continue;
                try { snapshot[index] = prop.Type.BindExpression(input, Source, cancellation); }
                catch (HtmlNextException error) when (error.Code == "HNCS001")
                {
                    if (!preview) context?.WarnSlot(this, index);
                }
            }
            else if (argument is not null) snapshot[index] = argument.Constant;
        }
        return snapshot;
    }

    public static void Enter(ScopedSlotLocal[] locals, object?[] caller, object?[] snapshot)
    {
        var offset = snapshot.Length / 2;
        foreach (var local in locals)
        {
            snapshot[offset + local.Prop] = caller[local.Slot];
            caller[local.Slot] = snapshot[local.Prop];
        }
    }

    public static void Leave(ScopedSlotLocal[] locals, object?[] caller, object?[] snapshot)
    {
        var offset = snapshot.Length / 2;
        foreach (var local in locals) caller[local.Slot] = snapshot[offset + local.Prop];
    }
}

internal sealed class ScopedSlotWarnings(Action<HtmlNextDiagnostic> report)
{
    private readonly HashSet<(ScopedSlotArguments Outlet, int Prop)> warned = [];
    public bool Warn(ScopedSlotArguments outlet, int prop) => warned.Add((outlet, prop));
    public void Report(HtmlNextDiagnostic diagnostic) => report(diagnostic);
}
