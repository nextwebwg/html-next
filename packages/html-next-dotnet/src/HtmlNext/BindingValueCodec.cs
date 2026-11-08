using System.Globalization;
using System.Text;

namespace HtmlNext;

internal static class BindingValueCodec
{
    internal static readonly object Undefined = new ExpressionValue(new("undefined"));

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

        void String(string value)
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

        HtmlNextException Error() => new("HNCS008", "Prepared inputs require finite serializable data without cycles or opaque values.", source);
    }

    private static object? Scalar(object? item)
    {
        if (item is ExpressionValue value) item = value.Type.Kind == "undefined" ? Undefined : value.IsDimension ? value.ScalarText() : value.Store();
        return item is sbyte or byte or short or ushort or int or uint or long or ulong or float or decimal
            ? Convert.ToDouble(item, CultureInfo.InvariantCulture) : item;
    }

    private static IEnumerable<int> Indices(ExpressionValue aggregate)
    {
        var indices = Enumerable.Range(0, aggregate.Count);
        return aggregate.Type.Kind == "list" ? indices : indices.OrderBy(index =>
            uint.TryParse(aggregate.Type.Fields![index].Name, NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            && number != uint.MaxValue && number.ToString(CultureInfo.InvariantCulture) == aggregate.Type.Fields[index].Name
                ? (long)number : (long)uint.MaxValue + index);
    }
}
