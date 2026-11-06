namespace HtmlNext;

internal sealed record LocalInitializer(int Slot, object? Constant)
{
    public void Initialize(object?[] values, string source, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        values[Slot] = Copy(Constant, source, cancellation);
    }

    internal static object? Snapshot(ExpressionValue value, bool copy, string source, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (value.Data is ExpressionValue[] computed)
        {
            ExecutionStack.Check(source);
            var stored = new object?[computed.Length];
            for (var index = 0; index < stored.Length; index++) stored[index] = Snapshot(computed[index], copy, source, cancellation);
            return new ExpressionValue(value.Type, stored).Store();
        }
        return copy ? Copy(value.Store(), source, cancellation) : value.Store();
    }

    private static object? Copy(object? value, string source, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (value is ExpressionValue { Data: object?[] items } aggregate)
            return new ExpressionValue(aggregate.Type, Copy(items, source, cancellation)).Store();
        if (value is not object?[] entries) return value;
        ExecutionStack.Check(source);
        var copy = new object?[entries.Length];
        for (var index = 0; index < copy.Length; index++) copy[index] = Copy(entries[index], source, cancellation);
        return copy;
    }
}
