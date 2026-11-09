using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Reflection;
using System.Text.Json;

namespace HtmlNext;

internal static class ModelAccess
{
    private static readonly ConcurrentDictionary<Type, FrozenDictionary<string, Func<object, object?>>> Getters = new();

    public static object? Read(object? model, string name) => TryRead(model, name, out var value) ? value : null;

    public static bool TryRead(object? model, string name, out object? value)
    {
        if (model is IReadOnlyDictionary<string, object?> readOnly)
            return readOnly.TryGetValue(name, out value);
        if (model is IDictionary<string, object?> dictionary)
            return dictionary.TryGetValue(name, out value);
        if (model is System.Collections.IDictionary entries)
        {
            if (entries.Contains(name)) { value = entries[name]; return true; }
            value = null; return false;
        }
        if (model is JsonElement json)
        {
            if (json.ValueKind == JsonValueKind.Object && json.TryGetProperty(name, out var property))
            {
                value = Unwrap(property);
                return true;
            }
            value = null;
            return false;
        }
        if (model is null) { value = null; return false; }
        var getters = Getters.GetOrAdd(model.GetType(), CreateGetters);
        if (getters.TryGetValue(name, out var getter)) { value = getter(model); return true; }
        value = null;
        return false;
    }

    public static object? Unwrap(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number => value.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        _ => value
    };

    public static bool IsRecord([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] object? value) => value is not null &&
        value is not (string or decimal or System.Collections.IList) && !value.GetType().IsPrimitive &&
        (value is not JsonElement json || json.ValueKind == JsonValueKind.Object);

    private static readonly ConcurrentDictionary<Type, ValueType> UnknownShapes = new();
    public static ValueType UnknownShape(Type type) => UnknownShapes.GetOrAdd(type, static type =>
        new("object", Fields: Getters.GetOrAdd(type, CreateGetters).Keys.Select(name => new ValueType.Field(name, new("unknown"))).ToArray(), Open: true));

    public static IEnumerable<string> Names(object model)
    {
        if (model is IReadOnlyDictionary<string, object?> readOnly) return readOnly.Keys;
        if (model is IDictionary<string, object?> dictionary) return dictionary.Keys;
        if (model is System.Collections.IDictionary entries) return entries.Keys.Cast<object>().OfType<string>();
        if (model is JsonElement json) return json.ValueKind == JsonValueKind.Object
            ? json.EnumerateObject().Select(property => property.Name) : [];
        return Getters.GetOrAdd(model.GetType(), CreateGetters).Keys;
    }

    public static bool HasOnlyMembers(object model, ValueType.Field[] fields)
    {
        // Called only for closed shapes whose fields are all required. Missing fields fail the
        // presence checks below, so a greater key count is enough to prove an extra dictionary key.
        if (model is IReadOnlyDictionary<string, object?> readOnly) return readOnly.Count <= fields.Length;
        if (model is IDictionary<string, object?> dictionary) return dictionary.Count <= fields.Length;
        if (model is System.Collections.IDictionary entries) return entries.Count <= fields.Length;
        foreach (var name in Names(model))
        {
            var known = false;
            foreach (var field in fields) if (field.Name == name) { known = true; break; }
            if (!known) return false;
        }
        return true;
    }

    public sealed record RecordReader(bool ExtraMembers, Func<object, object?>?[] Getters);

    public static RecordReader Record(Type type, ValueType.Field[] fields)
    {
        var getters = Getters.GetOrAdd(type, CreateGetters);
        if (getters.Keys.Any(name => !fields.Any(field => field.Name == name))) return new(true, []);
        var ordered = new Func<object, object?>?[fields.Length];
        for (var index = 0; index < ordered.Length; index++) getters.TryGetValue(fields[index].Name, out ordered[index]);
        return new(false, ordered);
    }

    private static FrozenDictionary<string, Func<object, object?>> CreateGetters(Type type)
    {
        var factory = typeof(ModelAccess).GetMethod(nameof(CreateGetter), BindingFlags.NonPublic | BindingFlags.Static)!;
        return type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => property.GetMethod?.IsPublic == true && property.GetIndexParameters().Length == 0)
            .ToFrozenDictionary(property => property.Name, property =>
                (Func<object, object?>)factory.MakeGenericMethod(type, property.PropertyType).Invoke(null, [property])!, StringComparer.Ordinal);
    }

    private static Func<object, object?> CreateGetter<T, TValue>(PropertyInfo property)
    {
        if (typeof(T).IsValueType)
        {
            var read = property.GetMethod!.CreateDelegate<StructGetter<T, TValue>>();
            return model => { var value = (T)model; return read(ref value); };
        }
        var getter = property.GetMethod!.CreateDelegate<Func<T, TValue>>();
        return model => getter((T)model);
    }

    private delegate TValue StructGetter<T, out TValue>(ref T instance);
}
