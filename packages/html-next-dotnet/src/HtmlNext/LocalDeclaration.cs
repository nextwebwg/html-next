namespace HtmlNext;

internal interface IDeclarationExpressionScope : IReadOnlyDictionary<string, (int Slot, ValueType Type)>
{
    ValueExpression Read(string name, int slot, ValueType type);
}

// Linked during compilation, then shared read-only. All evaluation state belongs to a render.
internal sealed class LocalDeclaration(string name, int slot, int index, int contextSlot, ValueType? seedType)
{
    public string Name { get; } = name;
    public int Slot { get; } = slot;
    public int Index { get; } = index;
    public int ContextSlot { get; } = contextSlot;
    public ValueType? SeedType { get; } = seedType is { Constraints: not null } ? seedType with { Constraints = null } : seedType;
    public ValueExpression Expression { get; private set; } = null!;
    public string? TypeMismatchDetail { get; } = seedType is null ? null : $"Input '{seedType.Path}' does not conform to '{seedType.Kind}'.";
    public void SetExpression(ValueExpression expression)
    {
        if (Expression is not null) throw new InvalidOperationException("Declaration is already linked.");
        Expression = expression;
    }
    public object? Read(object?[] values) => ((DeclarationEvaluation)values[ContextSlot]!).Read(this);
}

internal sealed class DeclarationEvaluation(object?[] values, int count, string source, CancellationToken cancellation, Action<HtmlNextDiagnostic>? onDiagnostic, bool[]? inputReady = null)
{
    // 0: unread, 1: evaluating, 2: available, 3: unavailable.
    private readonly byte[] status = new byte[count];
    public bool Ready { get; set; } = true;
    public bool[]? InputReady { get; } = inputReady;
    public void ObserveInput(int slot) { if (InputReady is { } inputs) Ready &= inputs[slot]; }
    public void RefreshWaiting(LocalDeclaration[] declarations)
    {
        foreach (var declaration in declarations)
            if (declaration.SeedType is null || status[declaration.Index] != 2)
            {
                status[declaration.Index] = 0;
                values[declaration.Slot] = declaration;
            }
    }
    public bool Initialized(LocalDeclaration declaration) => status[declaration.Index] == 2;

    public object? Read(LocalDeclaration declaration)
    {
        cancellation.ThrowIfCancellationRequested();
        if (status[declaration.Index] == 1) throw ValueType.Error(source, $"Declaration dependency cycle involving '{declaration.Name}'.");
        if (status[declaration.Index] != 0) return values[declaration.Slot];
        ExecutionStack.Check(source);
        status[declaration.Index] = 1;
        var parentReady = Ready;
        Ready = true;
        try
        {
            var result = declaration.Expression.Evaluate(values);
            var available = Ready && !result.IsAbsent && !result.IsInvalid;
            object? value = null;
            if (available)
            {
                if (declaration.SeedType is { } type && !result.IsNull)
                {
                    if (!CanSeed(type, result))
                    {
                        available = false;
                        onDiagnostic?.Invoke(new("HNCS004", declaration.TypeMismatchDetail!, source));
                    }
                    else try { value = type.Kind is "object" or "list" ? result.Store() : type.BindExpression(result, source, cancellation); }
                    catch (HtmlNextException error) when (error.Code == "HNCS001")
                    {
                        available = false;
                        onDiagnostic?.Invoke(new("HNCS004", error.Detail, source));
                    }
                }
                else value = result.Store();
                if (available) value = declaration.SeedType is not null
                    ? StateSeedCopy.Copy(value, source, cancellation)
                    : LocalInitializer.Snapshot(result, declaration.Expression.Constant, source, cancellation);
            }
            values[declaration.Slot] = value;
            status[declaration.Index] = available ? (byte)2 : (byte)3;
            return value;
        }
        finally { Ready = parentReady; }
    }

    private static bool CanSeed(ValueType type, ExpressionValue value) => type.Kind switch
    {
        "unknown" => true,
        "object" or "list" or "boolean" => type.Kind == value.Type.Kind,
        "number" => value.IsNumeric,
        "integer" => value.IsNumeric && Math.Truncate(value.Number) == value.Number,
        "string" or "keyword" => value.IsText || value.IsDimension,
        "length" or "percentage" or "duration" => value.Type.Kind == type.Kind || value.IsText,
        _ => false,
    };

    public object? Observe(LocalDeclaration declaration)
    {
        var value = Read(declaration);
        Ready &= status[declaration.Index] == 2;
        return value;
    }
}

// As in the shared inputDefault helper, a selected fallback owns its own prerequisites.
internal sealed record DeclarationDefaultExpression(ValueExpression Input, ValueExpression Fallback, ValueType ResultType, int ContextSlot) : ValueExpression(ResultType)
{
    public override ExpressionValue Evaluate(object?[] values)
    {
        var context = (DeclarationEvaluation)values[ContextSlot]!;
        var parentReady = context.Ready;
        var value = Input.Evaluate(values);
        if (!value.IsNull && !value.IsAbsent) return value;
        context.Ready = parentReady;
        return Fallback.Evaluate(values);
    }
}

internal static class StateSeedCopy
{
    public static object? Copy(object? value, string source, CancellationToken cancellation) => Copy(value, source, cancellation, null);

    private static object? Copy(object? value, string source, CancellationToken cancellation, Dictionary<object, object>? seen)
    {
        cancellation.ThrowIfCancellationRequested();
        if (value is ExpressionValue { Data: AcceptedChildEntry entry })
        {
            var fields = entry.Type.Fields!;
            var type = fields.Any(field => field.Type.Selection is not null)
                ? entry.Type with { Fields = fields.Select(field => field.Type.Selection is null
                    ? field : field with { Type = new("unknown", Path: field.Type.Path) }).ToArray() }
                : entry.Type;
            seen ??= new(ReferenceEqualityComparer.Instance);
            if (seen.TryGetValue(entry.Child, out var previousEntry)) return new ExpressionValue(type, previousEntry);
            ExecutionStack.Check(source);
            var copiedEntry = new object?[fields.Length];
            seen.Add(entry.Child, copiedEntry);
            for (var index = 0; index < copiedEntry.Length; index++) copiedEntry[index] = Copy(entry.Child[index], source, cancellation, seen);
            return new ExpressionValue(type, copiedEntry);
        }
        if (value is ExpressionValue aggregate)
            return new ExpressionValue(aggregate.Type, Copy(aggregate.Data, source, cancellation, seen), aggregate.Number, aggregate.Written).Store();
        if (value is not (object?[] or ExpressionValue[])) return value;
        seen ??= new(ReferenceEqualityComparer.Instance);
        if (seen.TryGetValue(value, out var previous)) return previous;
        ExecutionStack.Check(source);
        var length = value is object?[] entries ? entries.Length : ((ExpressionValue[])value).Length;
        var copy = new object?[length];
        seen.Add(value, copy);
        for (var index = 0; index < length; index++)
            copy[index] = Copy(value is object?[] items ? items[index] : ((ExpressionValue[])value)[index].Store(), source, cancellation, seen);
        return copy;
    }
}
