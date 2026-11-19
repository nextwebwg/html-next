using System.Collections;
using System.Text.Json;

namespace HtmlNext;

/// <summary>Request-local snapshots for untyped fields; declared closed shapes keep their direct binding path.</summary>
internal sealed class BindingSnapshot(string source, CancellationToken cancellation, bool transferable = false)
{
    private Dictionary<object, object>? seen;
    private static readonly ValueType Unknown = new("unknown");
    private static readonly ValueType List = new("list", Unknown);

    public object? Capture(object? value)
    {
        cancellation.ThrowIfCancellationRequested();
        if (ReferenceEquals(value, ExpressionValue.AbsentStorage) || ReferenceEquals(value, ExpressionValue.InvalidStorage)) return value;
        if (transferable && value is Delegate or System.Reflection.MemberInfo or Task or Stream or System.Numerics.BigInteger
            or DateTime or DateTimeOffset or DateOnly or TimeOnly or TimeSpan or Guid or Uri)
            throw new HtmlNextException("HNCS008", "Prepared inputs require plain serializable data, not opaque or executable values.", source);
        if (transferable && value is IDictionary dictionary && dictionary.Keys.Cast<object?>().Any(key => key is not string))
            throw new HtmlNextException("HNCS008", "Prepared input records require string member names.", source);
        if (value is JsonElement json) value = ModelAccess.Unwrap(json);
        if (value is null or string or bool or ExpressionValue || value.GetType().IsPrimitive || value is decimal) return value;
        seen ??= new(ReferenceEqualityComparer.Instance);
        if (seen.TryGetValue(value, out var previous)) return previous;
        ExecutionStack.Check(source);
        if (value is JsonElement { ValueKind: JsonValueKind.Array } array)
        {
            var items = new object?[array.GetArrayLength()];
            object stored = new ExpressionValue(List, items);
            seen.Add(value, stored);
            var index = 0;
            foreach (var item in array.EnumerateArray()) items[index++] = Capture(item);
            return stored;
        }
        if (value is IList list)
        {
            var items = new object?[list.Count];
            object stored = new ExpressionValue(List, items);
            seen.Add(value, stored);
            for (var index = 0; index < items.Length; index++) items[index] = Capture(list[index]);
            return stored;
        }
        if (value is IEnumerable sequence && value is not (IDictionary or IReadOnlyDictionary<string, object?> or IDictionary<string, object?> or JsonElement))
        {
            var entries = new List<object?>();
            foreach (var entry in sequence) { cancellation.ThrowIfCancellationRequested(); entries.Add(entry); }
            var items = new object?[entries.Count];
            object stored = new ExpressionValue(List, items);
            seen.Add(value, stored);
            for (var index = 0; index < items.Length; index++) items[index] = Capture(entries[index]);
            return stored;
        }
        var type = value is IDictionary or IReadOnlyDictionary<string, object?> or IDictionary<string, object?> or JsonElement
            ? new ValueType("object", Fields: ModelAccess.Names(value).Select(name => new ValueType.Field(name, Unknown)).ToArray(), Open: true)
            : ModelAccess.UnknownShape(value.GetType());
        var fields = type.Fields!;
        var values = new object?[fields.Length];
        object result = new ExpressionValue(type, values);
        seen.Add(value, result);
        for (var index = 0; index < fields.Length; index++) values[index] = Capture(ModelAccess.Read(value, fields[index].Name));
        return result;
    }
}
