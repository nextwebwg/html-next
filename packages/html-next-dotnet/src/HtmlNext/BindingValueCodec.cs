using System.Globalization;
using System.Text;
using System.Text.Json;

namespace HtmlNext;

internal static class BindingValueCodec
{
    internal static readonly object Undefined = new ExpressionValue(new("undefined"));

    public static object? Decode(string encoded, string source, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        var references = new List<object>();
        try { using var document = JsonDocument.Parse(encoded, new() { MaxDepth = int.MaxValue }); return Read(document.RootElement); }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or OverflowException)
        { throw Error(error); }

        object? Read(JsonElement item)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            if (item.ValueKind != JsonValueKind.Array) throw Error();
            var length = item.GetArrayLength();
            if (length is < 1 or > 2 || item[0].ValueKind != JsonValueKind.String) throw Error();
            var kind = item[0].GetString();
            if (length == 1) return kind switch
            {
                "undefined" => Undefined, "absent" => ExpressionValue.AbsentStorage,
                "nonconforming" => ExpressionValue.InvalidStorage, "negative-zero" => -0d, _ => throw Error()
            };
            var value = item[1];
            if (kind == "reference" && value.TryGetInt32(out var index) && (uint)index < (uint)references.Count) return references[index];
            if (kind == "value" && value.ValueKind is JsonValueKind.Null or JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False) return Plain(value);
            if (kind == "json" && value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
            {
                var result = Plain(value)!; references.Add(result); return result;
            }
            if (kind == "array" && value.ValueKind == JsonValueKind.Array)
            {
                var result = new object?[value.GetArrayLength()]; references.Add(result);
                for (var i = 0; i < result.Length; i++) result[i] = Read(value[i]);
                return result;
            }
            if (kind == "object" && value.ValueKind == JsonValueKind.Array)
            {
                var result = new Dictionary<string, object?>(StringComparer.Ordinal); references.Add(result);
                foreach (var entry in value.EnumerateArray())
                {
                    if (entry.ValueKind != JsonValueKind.Array || entry.GetArrayLength() != 2 || entry[0].ValueKind != JsonValueKind.String) throw Error();
                    if (!result.TryAdd(String(entry[0]), Read(entry[1]))) throw Error();
                }
                return result;
            }
            throw Error();
        }

        object? Plain(JsonElement value)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            switch (value.ValueKind)
            {
                case JsonValueKind.Null: return null;
                case JsonValueKind.String: return String(value);
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Number:
                    var number = value.GetDouble(); return double.IsFinite(number) ? number : throw Error();
                case JsonValueKind.Array: return value.EnumerateArray().Select(Plain).ToArray();
                case JsonValueKind.Object:
                    var result = new Dictionary<string, object?>(StringComparer.Ordinal);
                    var bytes = Encoding.UTF8.GetBytes(value.GetRawText());
                    var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = int.MaxValue });
                    reader.Read();
                    while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
                    {
                        var name = Unescape("\"" + Encoding.UTF8.GetString(reader.ValueSpan) + "\"");
                        reader.Read();
                        using var field = JsonDocument.ParseValue(ref reader);
                        result[name] = Plain(field.RootElement);
                    }
                    return result;
                default: throw Error();
            }
        }

        // JsonElement.GetString rejects lone UTF-16 surrogates that the JavaScript codec preserves.
        string String(JsonElement value) => Unescape(value.GetRawText());
        string Unescape(string raw)
        {
            var text = new StringBuilder();
            for (var i = 1; i < raw.Length - 1; i++)
            {
                var c = raw[i];
                if (c != '\\') { text.Append(c); continue; }
                c = raw[++i];
                if (c == 'u') { text.Append((char)ushort.Parse(raw.AsSpan(i + 1, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture)); i += 4; }
                else text.Append(c switch { 'b' => '\b', 'f' => '\f', 'n' => '\n', 'r' => '\r', 't' => '\t', _ => c });
            }
            return text.ToString();
        }
        HtmlNextException Error(Exception? inner = null) => new("HNCS008", "Malformed JavaScript SDK prepared value.", source, inner);
    }

    public static string Encode(object? input, string source, CancellationToken cancellation = default)
    {
        var value = ReferenceEquals(input, Undefined) ? input : new BindingSnapshot(source, cancellation, transferable: true).Capture(input);
        var counts = new Dictionary<object, int>(ReferenceEqualityComparer.Instance);
        var plain = new Dictionary<object, bool>(ReferenceEqualityComparer.Instance);
        var references = new Dictionary<object, int>(ReferenceEqualityComparer.Instance);
        var ancestors = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var text = new StringBuilder();
        Count(value);
        Write(value);
        return text.ToString();

        void Count(object? item)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            if (item is not ExpressionValue aggregate || aggregate.Type.Kind is not ("object" or "list")) return;
            var identity = aggregate.Data!;
            counts.TryGetValue(identity, out var count);
            counts[identity] = count + 1;
            if (count == 0) foreach (var index in Indices(aggregate)) Count(aggregate.ItemUnchecked(index));
        }

        bool Plain(object? item)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            if (item is ExpressionValue aggregate && aggregate.Type.Kind is "object" or "list")
            {
                var identity = aggregate.Data!;
                if (plain.TryGetValue(identity, out var known)) return known;
                plain[identity] = false;
                foreach (var index in Indices(aggregate))
                {
                    var child = aggregate.ItemUnchecked(index);
                    if (child.Type.Kind is "object" or "list" && counts[child.Data!] != 1 || !Plain(child)) return false;
                }
                return plain[identity] = true;
            }
            item = Scalar(item);
            return item is null or string or bool || item is double number && double.IsFinite(number) && !(number == 0 && double.IsNegative(number));
        }

        void Write(object? item)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            text.Append('[');
            if (item is ExpressionValue aggregate && aggregate.Type.Kind is "object" or "list")
            {
                var identity = aggregate.Data!;
                if (ancestors.Contains(identity)) throw Error();
                if (references.TryGetValue(identity, out var index)) text.Append("\"reference\",").Append(index);
                else
                {
                    references.Add(identity, references.Count);
                    if (Plain(aggregate)) { text.Append("\"json\","); WritePlain(aggregate); }
                    else
                    {
                        ancestors.Add(identity);
                        var record = aggregate.Type.Kind == "object";
                        text.Append(record ? "\"object\",[" : "\"array\",[");
                        var first = true;
                        foreach (var member in Indices(aggregate))
                        {
                            if (!first) text.Append(','); first = false;
                            if (record) { text.Append('['); String(aggregate.Type.Fields![member].Name); text.Append(','); }
                            Write(aggregate.ItemUnchecked(member));
                            if (record) text.Append(']');
                        }
                        text.Append(']'); ancestors.Remove(identity);
                    }
                }
            }
            else
            {
                item = Scalar(item);
                if (ReferenceEquals(item, Undefined)) text.Append("\"undefined\"");
                else if (ReferenceEquals(item, ExpressionValue.AbsentStorage)) text.Append("\"absent\"");
                else if (ReferenceEquals(item, ExpressionValue.InvalidStorage)) text.Append("\"nonconforming\"");
                else if (item is double number && number == 0 && double.IsNegative(number)) text.Append("\"negative-zero\"");
                else { text.Append("\"value\","); WritePlain(item); }
            }
            text.Append(']');
        }

        void WritePlain(object? item)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            if (item is ExpressionValue aggregate && aggregate.Type.Kind is "object" or "list")
            {
                var record = aggregate.Type.Kind == "object";
                text.Append(record ? '{' : '[');
                var first = true;
                foreach (var index in Indices(aggregate))
                {
                    if (!first) text.Append(','); first = false;
                    if (record) { String(aggregate.Type.Fields![index].Name); text.Append(':'); }
                    WritePlain(aggregate.ItemUnchecked(index));
                }
                text.Append(record ? '}' : ']');
                return;
            }
            item = Scalar(item);
            switch (item)
            {
                case null: text.Append("null"); break;
                case bool boolean: text.Append(boolean ? "true" : "false"); break;
                case string scalar: String(scalar); break;
                case double number when double.IsFinite(number): text.Append(ExpressionValue.Numeric(number).ScalarText()); break;
                default: throw Error();
            }
        }

        void String(string value) => AppendJsonString(text, value);

        HtmlNextException Error() => new("HNCS008", "Prepared inputs require finite serializable data without cycles or opaque values.", source);
    }

    private static object? Scalar(object? item)
    {
        if (item is ExpressionValue value) item = value.Type.Kind == "undefined" ? Undefined : value.IsDimension ? value.ScalarText() : value.Store();
        return item is sbyte or byte or short or ushort or int or uint or long or ulong or float or decimal
            ? Convert.ToDouble(item, CultureInfo.InvariantCulture) : item;
    }

    internal static void AppendJsonString(StringBuilder text, string value)
    {
        text.Append('"');
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            switch (character)
            {
                case '"': text.Append("\\\""); break;
                case '\\': text.Append("\\\\"); break;
                case '\b': text.Append("\\b"); break;
                case '\t': text.Append("\\t"); break;
                case '\n': text.Append("\\n"); break;
                case '\f': text.Append("\\f"); break;
                case '\r': text.Append("\\r"); break;
                default:
                    if (char.IsHighSurrogate(character) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
                        text.Append(character).Append(value[++index]);
                    else if (character < 32 || char.IsSurrogate(character)) text.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    else text.Append(character);
                    break;
            }
        }
        text.Append('"');
    }

    internal static IEnumerable<int> Indices(ExpressionValue aggregate)
    {
        var indices = Enumerable.Range(0, aggregate.Count);
        return aggregate.Type.Kind == "list" ? indices : indices.OrderBy(index =>
            uint.TryParse(aggregate.Type.Fields![index].Name, NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            && number != uint.MaxValue && number.ToString(CultureInfo.InvariantCulture) == aggregate.Type.Fields[index].Name
                ? (long)number : (long)uint.MaxValue + index);
    }
}
