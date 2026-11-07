using System.Collections;
using System.Globalization;
using System.Collections.Concurrent;
using System.Runtime.CompilerServices;

namespace HtmlNext;

internal sealed record ValueType(string Kind, ValueType? Item = null, ValueType.Field[]? Fields = null, string Path = "", bool Open = false, ValueConstraints? Constraints = null, bool Reference = false, ScopedSlotContract? ChildSource = null)
{
    private readonly ConcurrentDictionary<Type, ModelAccess.RecordReader>? readers = Kind == "object" ? new() : null;
    internal sealed record Field(string Name, ValueType Type, bool Optional = false);
    public bool NeedsSnapshot { get; } = Kind == "unknown" || Open || Item?.NeedsSnapshot == true || Fields?.Any(field => field.Type.NeedsSnapshot) == true;
    public bool HasAttributeForm => Kind is not ("unknown" or "event" or "null") && Item?.HasAttributeForm != false && Fields?.Any(member => !member.Type.HasAttributeForm) != true;

    public ValueType AsReference() => this with
    {
        Reference = true,
        Item = Item?.AsReference(),
        Fields = Fields?.Select(field => field with { Type = field.Type.AsReference() }).ToArray()
    };

    public ExpressionValue CheckReference(ExpressionValue value)
    {
        if (!Reference || value.IsNull || value.IsAbsent || value.IsInvalid || Kind == "unknown") return value;
        if (Kind is "object" or "list") return value.Type.Kind == Kind ? ReferenceValue(value) : ExpressionValue.Invalid;
        if (Kind is "length" or "percentage" or "duration" && value.IsText)
        {
            var text = (string)value.Data!;
            if (Kind == "length" && text == "0") return ExpressionValue.Text(text);
            return Dimensions.TryParse(text, out var dimension) && dimension.Type.Kind == Kind ? dimension : ExpressionValue.Invalid;
        }
        if (Kind is "string" or "keyword" && value.IsDimension) value = ExpressionValue.Text(value.ScalarText());
        var valid = Kind switch
        {
            "string" => value.IsText,
            "keyword" => value.IsText && IsKeyword((string)value.Data!),
            "number" => value.IsNumeric,
            "integer" => value.IsNumeric && Math.Truncate(value.Number) == value.Number,
            _ => value.Type.Kind == Kind,
        };
        return valid ? value : ExpressionValue.Invalid;
    }

    private static readonly ConditionalWeakTable<ValueType, ReferenceLayouts> ReferenceViews = new();
    public ExpressionValue ReferenceValue(ExpressionValue value) => Reference && Kind is "object" or "list" && value.Type.Kind == Kind
        ? new ExpressionValue(ReferenceLayout(value.Type), value.Data) : value;

    private ValueType ReferenceLayout(ValueType actual) => ReferenceEquals(this, actual) ? this
        : ReferenceViews.GetValue(this, static owner => new ReferenceLayouts(owner)).Get(actual);

    private ValueType CreateReferenceLayout(ValueType actual)
    {
        if (Kind == "list") return new("list", Item!.ReferenceLayoutFor(actual.Item!), Reference: true);
        var fields = new Field[actual.Fields!.Length];
        for (var index = 0; index < fields.Length; index++)
        {
            var supplied = actual.Fields[index];
            var declared = Array.Find(Fields!, field => field.Name == supplied.Name);
            fields[index] = new(supplied.Name, declared?.Type.ReferenceLayoutFor(supplied.Type) ?? UnknownReference, supplied.Optional);
        }
        return new("object", Fields: fields, Path: Path, Open: Open, Reference: true);
    }

    private ValueType ReferenceLayoutFor(ValueType actual) => Reference && Kind is "object" or "list" && actual.Kind == Kind
        ? ReferenceLayout(actual) : this;

    private static readonly ValueType UnknownReference = new("unknown");
    private sealed class ReferenceLayouts(ValueType owner)
    {
        private readonly ConditionalWeakTable<ValueType, ValueType> layouts = new();
        private readonly ConditionalWeakTable<ValueType, ValueType>.CreateValueCallback create = owner.CreateReferenceLayout;
        public ValueType Get(ValueType actual) => layouts.GetValue(actual, create);
    }

    public static ValueType Parse(string text, string source, bool javaScriptValues = false)
    {
        var parser = new TypeParser(text, source, javaScriptValues);
        var type = parser.ReadType();
        parser.Space();
        if (parser.Position != text.Length) throw Error(source, $"Unsupported type '{text}'.");
        return type;
    }

    public ValueType At(string path) => this with
    {
        Path = path,
        Item = Item?.At(path + "[]"),
        Fields = Fields?.Select(field => field with { Type = field.Type.At(path + "." + field.Name) }).ToArray()
    };

    public object? Bind(object? value, string source, CancellationToken cancellation, BindingSnapshot? snapshot = null)
    {
        snapshot ??= NeedsSnapshot ? new(source, cancellation) : null;
        var result = BindCore(value, source, cancellation, snapshot);
        if (Constraints is not null && result is not null && !Constraints.Accepts(result))
        {
            var errors = new List<HtmlNextValidationError>();
            Constraints.Check(result, Path, source, errors);
            if (errors.Count > 0) throw Error(source, $"Input '{errors[0].Path}' violates {errors[0].Reason}.");
        }
        return result;
    }

    private object? BindCore(object? value, string source, CancellationToken cancellation, BindingSnapshot? snapshot)
    {
        cancellation.ThrowIfCancellationRequested();
        if (Kind == "unknown") return snapshot!.Capture(value);
        if (Kind == "list" && value is System.Text.Json.JsonElement { ValueKind: System.Text.Json.JsonValueKind.Array } jsonList)
        {
            var result = new object?[jsonList.GetArrayLength()];
            var index = 0;
            foreach (var item in jsonList.EnumerateArray()) result[index++] = Item!.Bind(item, source, cancellation, snapshot);
            return result;
        }
        if (value is System.Text.Json.JsonElement json) value = ModelAccess.Unwrap(json);
        if (Kind == "string" && value is string || Kind == "boolean" && value is bool) return value;
        if (Kind == "keyword" && value is string keyword && IsKeyword(keyword)) return keyword;
        if (Kind is "length" or "percentage" or "duration" && value is string dimension
            && (Kind == "length" && dimension == "0" || Dimensions.TryParse(dimension, out var quantity) && quantity.Type.Kind == Kind)) return dimension;
        if (Kind is "number" or "integer" && value is double scalar && double.IsFinite(scalar) && (Kind != "integer" || Math.Truncate(scalar) == scalar)) return value;
        if (Kind is "number" or "integer" && value is sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal)
        {
            var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (double.IsFinite(number) && (Kind != "integer" || Math.Truncate(number) == number)) return value;
        }
        if (Kind == "list" && value is IEnumerable list && value is not string)
        {
            if (value is object?[] array)
            {
                var result = new object?[array.Length];
                for (var index = 0; index < array.Length; index++) result[index] = Item!.Bind(array[index], source, cancellation, snapshot);
                return result;
            }
            var items = new List<object?>();
            foreach (var item in list) items.Add(Item!.Bind(item, source, cancellation, snapshot));
            return items.ToArray();
        }
        if (Kind == "object" && (Open || Fields!.Any(field => field.Optional))) return BindFlexibleObject(value, source, cancellation, snapshot);
        if (Kind == "object" && ModelAccess.IsRecord(value))
        {
            var fields = Fields!;
            if (value is not (IReadOnlyDictionary<string, object?> or IDictionary<string, object?> or System.Collections.IDictionary or System.Text.Json.JsonElement))
            {
                var reader = readers!.GetOrAdd(value.GetType(), static (type, shape) => ModelAccess.Record(type, shape), fields);
                if (reader.ExtraMembers) throw Error(source, $"Input '{Path}' contains an undeclared field.");
                var record = new object?[fields.Length];
                for (var index = 0; index < fields.Length; index++)
                {
                    var getter = reader.Getters[index] ?? throw Error(source, $"Required field '{fields[index].Type.Path}' is absent.");
                    record[index] = fields[index].Type.Bind(getter(value), source, cancellation, snapshot);
                }
                return record;
            }
            if (!ModelAccess.HasOnlyMembers(value, fields)) throw Error(source, $"Input '{Path}' contains an undeclared field.");
            var result = new object?[fields.Length];
            for (var index = 0; index < fields.Length; index++)
            {
                if (!ModelAccess.TryRead(value, fields[index].Name, out var input)) throw Error(source, $"Required field '{fields[index].Type.Path}' is absent.");
                result[index] = fields[index].Type.Bind(input, source, cancellation, snapshot);
            }
            return result;
        }
        throw Error(source, $"Input '{Path}' does not conform to '{Kind}'.");
    }

    private object? BindFlexibleObject(object? value, string source, CancellationToken cancellation, BindingSnapshot? snapshot)
    {
        if (!ModelAccess.IsRecord(value))
            throw Error(source, $"Input '{Path}' does not conform to 'object'.");
        var shape = new List<Field>(); var items = new List<object?>();
        foreach (var field in Fields!)
        {
            cancellation.ThrowIfCancellationRequested();
            if (!ModelAccess.TryRead(value, field.Name, out var input))
            {
                if (!field.Optional) throw Error(source, $"Required field '{field.Type.Path}' is absent.");
                continue;
            }
            shape.Add(field);
            items.Add(field.Optional && input is null ? null : field.Type.Bind(input, source, cancellation, snapshot));
        }
        foreach (var name in ModelAccess.Names(value))
        {
            if (Fields.Any(field => field.Name == name)) continue;
            if (!Open) throw Error(source, $"Input '{Path}' contains undeclared field '{name}'.");
            shape.Add(new(name, new("unknown")));
            items.Add(snapshot!.Capture(ModelAccess.Read(value, name)));
        }
        return new ExpressionValue(this with { Fields = shape.ToArray() }, items.ToArray());
    }

    public bool CanBindType(ValueType value)
    {
        if (Kind == "object" && value.Kind == "object") return (Open || value.Fields!.All(other => Fields!.Any(field => field.Name == other.Name)))
            && Fields!.All(field => value.Fields!.FirstOrDefault(other => other.Name == field.Name) is { } other
                ? field.Type.CanBindType(other.Type) : field.Optional);
        if (Kind == "list" && value.Kind == "list") return Item!.CanBindType(value.Item!);
        if (Kind == "unknown") return true;
        if (ExpressionCompiler.Compatible(this, value)) return true;
        return Kind is "string" or "keyword" && value.Kind is "length" or "percentage" or "duration"
            || Kind is "length" or "percentage" or "duration" && value.Kind is "string" or "keyword";
    }

    public object? BindExpression(ExpressionValue value, string source, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (Kind == "unknown") return value.Store();
        if (Kind == "list" && value.Type.Kind == "list")
        {
            var items = new object?[value.Count];
            for (var index = 0; index < items.Length; index++) items[index] = Item!.BindExpression(value.Item(index), source, cancellation);
            return items;
        }
        if (Kind == "object" && value.Type.Kind == "object")
        {
            var fields = Fields!;
            foreach (var field in value.Type.Fields!)
                if (!Open && !fields.Any(declared => declared.Name == field.Name)) throw Error(source, $"Input '{Path}' contains an undeclared field.");
            if (!Open && fields.All(field => !field.Optional))
            {
                var fixedRecord = new object?[fields.Length];
                for (var index = 0; index < fields.Length; index++) fixedRecord[index] = fields[index].Type.BindExpression(value.Member(fields[index].Name), source, cancellation);
                return fixedRecord;
            }
            var shape = new List<Field>(); var record = new List<object?>();
            foreach (var field in fields)
            {
                var member = value.Member(field.Name);
                if (member.IsAbsent && field.Optional) continue;
                shape.Add(field);
                record.Add(field.Optional && member.IsNull ? null : field.Type.BindExpression(member, source, cancellation));
            }
            if (Open) foreach (var field in value.Type.Fields!)
            {
                if (fields.Any(declared => declared.Name == field.Name)) continue;
                shape.Add(field); record.Add(value.Member(field.Name).Store());
            }
            return Open || fields.Any(field => field.Optional)
                ? new ExpressionValue(this with { Fields = shape.ToArray() }, record.ToArray()) : record.ToArray();
        }
        if (value.IsScalar && !value.IsNull)
        {
            if (value.IsDimension) return Bind(value.ScalarText(), source, cancellation);
            return Bind(value.Store(), source, cancellation);
        }
        throw Error(source, $"Input '{Path}' does not conform to '{Kind}'.");
    }

    public static HtmlNextException Error(string source, string message) => new("HNCS001", message, source);

    private static bool IsKeyword(string text)
    {
        if (text.Length == 0) return false;
        foreach (var character in text) if (!char.IsAsciiLetterOrDigit(character) && character is not ('_' or '-')) return false;
        return true;
    }

    private sealed class TypeParser(string text, string source, bool javaScriptValues)
    {
        public int Position { get; private set; }
        public void Space() { while (Position < text.Length && char.IsWhiteSpace(text[Position])) Position++; }
        private bool Take(char token)
        {
            Space();
            if (Position >= text.Length || text[Position] != token) return false;
            Position++;
            return true;
        }
        private void Expect(char token)
        {
            if (!Take(token)) throw Error(source, $"Expected '{token}' in type '{text}'.");
        }
        private string Name(bool key = false)
        {
            Space();
            if (key && Position < text.Length && text[Position] is '\'' or '"')
            {
                var quote = text[Position++];
                var value = new System.Text.StringBuilder();
                while (Position < text.Length && text[Position] != quote)
                {
                    if (text[Position] == '\\' && ++Position == text.Length) throw Error(source, "Unclosed object key.");
                    value.Append(text[Position++]);
                }
                if (Position == text.Length) throw Error(source, "Unclosed object key.");
                Position++;
                return value.ToString();
            }
            var start = Position;
            while (Position < text.Length && !char.IsWhiteSpace(text[Position]) && !"(){}:,?".Contains(text[Position])) Position++;
            if (start == Position) throw Error(source, $"Expected a name in type '{text}'.");
            var name = text[start..Position];
            if (key && !ExpressionCompiler.IsIdentifier(name)) throw Error(source, $"Invalid object key '{name}'. Quote external keys.");
            return name;
        }
        public ValueType ReadType()
        {
            var kind = Name();
            if (javaScriptValues && kind is "event" or "null") return new(kind);
            if (kind is "string" or "number" or "integer" or "boolean" or "keyword" or "length" or "percentage" or "duration" or "unknown") return new(kind);
            if (kind == "list")
            {
                Expect('(');
                var item = ReadType();
                Expect(')');
                return new(kind, item);
            }
            if (kind == "object")
            {
                if (!Take('('))
                {
                    if (javaScriptValues) return new(kind, Fields: [], Open: true);
                    throw Error(source, $"Expected '(' in type '{text}'.");
                }
                Expect('{');
                var fields = new List<Field>();
                var open = false;
                while (!Take('}'))
                {
                    Space();
                    if (text.AsSpan(Position).StartsWith("..."))
                    {
                        Position += 3; open = true; Take(','); Expect('}'); break;
                    }
                    var name = Name(true);
                    if (fields.Any(field => field.Name == name)) throw Error(source, $"Duplicate object field '{name}'.");
                    var optional = Take('?'); Expect(':');
                    fields.Add(new(name, ReadType(), optional));
                    if (!Take(',')) { Expect('}'); break; }
                }
                Expect(')');
                return new(kind, Fields: fields.ToArray(), Open: open);
            }
            throw Error(source, $"Type '{kind}' is not implemented in the measured rendering slice.");
        }
    }
}
