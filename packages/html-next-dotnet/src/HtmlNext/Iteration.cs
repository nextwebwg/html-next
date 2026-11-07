using System.Globalization;
using System.Runtime.CompilerServices;

namespace HtmlNext;

internal sealed class IterationIndexBinding
{
    public int Slot { get; set; } = -1;
}

internal sealed record IterationIndexExpression(int Slot) : ValueExpression(ExpressionValue.NumberType)
{
    public override ExpressionValue Evaluate(object?[] values) => values[Slot] is IterationIndex index ? ExpressionValue.Numeric(index.Value) : ExpressionValue.Absent;
}

internal sealed class IterationIndex
{
    public int Value { get; set; }
}

internal sealed record IterationSort(ValueExpression Read, bool Member, bool Descending);
internal sealed record IterationPlan(IterationIndexBinding Index, ValueExpression? Where, ValueExpression? Limit, ValueExpression? Key, IterationSort[] Sort, string Source)
{
    public bool NeedsPlan => Index.Slot >= 0 || Limit is not null || Key is not null || Sort.Length > 0;
}

internal sealed record PlannedEach(ValueExpression Expression, int Slot, RenderOperation[] Body, IterationPlan Plan) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation)
    {
        using var scope = new IterationScope(values, Slot, Plan.Index.Slot);
        var rows = Prepare(values, cancellation);
        HashSet<IterationKey>? keys = Plan.Key is null ? null : [];
        for (var index = 0; index < rows.Count; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            scope.Bind(rows, index);
            CheckKey(keys, values);
            if (AnyNodes(Body, values, context, cancellation)) return true;
        }
        return false;
    }

    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WriteRows(ref writer, values, cancellation, false);
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WriteRows(ref writer, values, cancellation, true);

    private void WriteRows(ref HtmlWriter writer, object?[] values, CancellationToken cancellation, bool deferred)
    {
        using var scope = new IterationScope(values, Slot, Plan.Index.Slot);
        var rows = Prepare(values, cancellation);
        HashSet<IterationKey>? keys = Plan.Key is null ? null : [];
        for (var index = 0; index < rows.Count; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            scope.Bind(rows, index);
            CheckKey(keys, values);
            foreach (var operation in Body)
                if (deferred) operation.WriteDeferred(ref writer, values, cancellation); else operation.Write(ref writer, values, cancellation);
        }
    }

    internal void Visit(object?[] values, CancellationToken cancellation, Action visit)
    {
        using var scope = new IterationScope(values, Slot, Plan.Index.Slot);
        var rows = Prepare(values, cancellation);
        HashSet<IterationKey>? keys = Plan.Key is null ? null : [];
        for (var index = 0; index < rows.Count; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            scope.Bind(rows, index);
            CheckKey(keys, values);
            visit();
        }
    }

    private void CheckKey(HashSet<IterationKey>? keys, object?[] values)
    {
        if (keys is not null && !keys.Add(new(Plan.Key!.Evaluate(values))))
            throw ValueType.Error(Plan.Source, "A keyed list produced a duplicate key.");
    }

    private IterationRows Prepare(object?[] values, CancellationToken cancellation)
    {
        var list = Expression.Evaluate(values);
        if (list.Type.Kind != "list") return new(list, null, 0);
        int[]? indices = null;
        var count = list.Count;
        if (Plan.Where is not null || Plan.Sort.Length > 0)
        {
            var selected = new List<int>(count);
            for (var index = 0; index < count; index++)
            {
                cancellation.ThrowIfCancellationRequested();
                values[Slot] = IterationRows.Item(list, index);
                if (Plan.Where is null || Plan.Where.Evaluate(values).Truthy) selected.Add(index);
            }
            indices = Plan.Sort.Length == 0 ? selected.ToArray() : Sort(list, selected, values, cancellation);
            count = indices.Length;
        }
        cancellation.ThrowIfCancellationRequested();
        values[Slot] = ExpressionValue.AbsentStorage;
        if (Plan.Limit is not null)
        {
            var limit = Plan.Limit.Evaluate(values);
            if (limit.IsNumeric) count = (int)Math.Min(count, Math.Max(0, Math.Truncate(limit.Number)));
        }
        return new(list, indices, count);
    }

    private int[] Sort(ExpressionValue list, List<int> selected, object?[] values, CancellationToken cancellation)
    {
        var width = Plan.Sort.Length;
        var keys = new IterationOrderValue[checked(selected.Count * width)];
        var textComparison = new bool[width];
        var indices = new int[selected.Count];
        for (var index = 0; index < indices.Length; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            indices[index] = index;
            for (var key = 0; key < width; key++)
            {
                var value = SortValue(list, selected[index], Plan.Sort[key], values);
                keys[index * width + key] = new(value.Number, value.IsNumeric, value.IsNumeric ? null : Text(value));
                textComparison[key] |= !value.IsNumeric;
            }
        }
        for (var key = 0; key < width; key++) if (textComparison[key])
            for (var index = 0; index < indices.Length; index++)
            {
                ref var value = ref keys[index * width + key];
                if (value.Numeric) value = value with { Text = ExpressionValue.Numeric(value.Number).ScalarText() };
            }
        var comparison = CultureInfo.CurrentCulture.CompareInfo;
        Array.Sort(indices, (left, right) =>
        {
            for (var key = 0; key < width; key++)
            {
                var a = keys[left * width + key]; var b = keys[right * width + key];
                var order = a.Numeric && b.Numeric ? a.Number.CompareTo(b.Number)
                    : comparison.Compare(a.Text, b.Text, CompareOptions.None);
                if (order != 0) return Plan.Sort[key].Descending ? -Math.Sign(order) : order;
            }
            return left.CompareTo(right);
        });
        for (var index = 0; index < indices.Length; index++) indices[index] = selected[indices[index]];
        return indices;
    }

    private ExpressionValue SortValue(ExpressionValue list, int index, IterationSort sort, object?[] values)
    {
        var row = list.ItemUnchecked(index);
        if (!sort.Member || row.Type.Kind != "object") return row;
        values[Slot] = IterationRows.Item(list, index);
        return sort.Read.Evaluate(values);
    }

    private string Text(ExpressionValue value)
    {
        if (value.Type.Kind == "boolean") return value.Number == 0 ? "false" : "true";
        if (value.Type.Kind != "list") return value.ScalarText();
        ExecutionStack.Check(Plan.Source);
        var items = new string[value.Count];
        for (var index = 0; index < items.Length; index++) items[index] = Text(value.ItemUnchecked(index));
        return string.Join(' ', items);
    }
}

internal readonly record struct IterationOrderValue(double Number, bool Numeric, string? Text);

internal readonly record struct IterationRows(ExpressionValue List, int[]? Indices, int Count)
{
    public object? At(int index) => Item(List, Indices is null ? index : Indices[index]);
    public static object? Item(ExpressionValue list, int index) => list.Type.Reference ? list.ItemUnchecked(index).Store()
        : list.Data is object?[] values ? values[index] : list.Item(index).Store();
}

internal readonly ref struct IterationScope
{
    private readonly object?[] values;
    private readonly int slot;
    private readonly int indexSlot;
    private readonly object? previous;
    private readonly object? previousIndex;
    private readonly IterationIndex? index;
    public IterationScope(object?[] values, int slot, int indexSlot)
    {
        this.values = values; this.slot = slot; this.indexSlot = indexSlot;
        previous = values[slot];
        previousIndex = indexSlot < 0 ? null : values[indexSlot];
        index = indexSlot < 0 ? null : new IterationIndex();
        if (index is not null) values[indexSlot] = index;
    }
    public void Bind(IterationRows rows, int index)
    {
        values[slot] = rows.At(index);
        if (this.index is not null) this.index.Value = index;
    }
    public void Dispose()
    {
        values[slot] = previous;
        if (indexSlot >= 0) values[indexSlot] = previousIndex;
    }
}

internal readonly struct IterationKey(ExpressionValue value) : IEquatable<IterationKey>
{
    private readonly string kind = value.IsNumeric ? "number" : value.IsText || value.IsDimension ? "string"
        : value.Type.Kind is "object" or "list" ? "reference" : value.Type.Kind;
    private readonly object? data = value.IsDimension ? value.ScalarText() : value.Data;
    private readonly double number = value.Number;
    public bool Equals(IterationKey other) => kind == other.kind && (kind switch
    {
        "number" or "boolean" => number == other.number,
        "string" => string.Equals((string?)data, (string?)other.data, StringComparison.Ordinal),
        "reference" => ReferenceEquals(data, other.data),
        _ => true,
    });
    public override bool Equals(object? other) => other is IterationKey key && Equals(key);
    public override int GetHashCode() => HashCode.Combine(kind, kind switch
    {
        "number" or "boolean" => number.GetHashCode(),
        "string" => data?.GetHashCode() ?? 0,
        "reference" => data is null ? 0 : RuntimeHelpers.GetHashCode(data),
        _ => 0,
    });
}
