using System.Globalization;

namespace HtmlNext;

// Numbers stay unboxed while expressions calculate. Bound model arrays retain the compact
// representation used by the direct-path writer; expression-created arrays carry these values.
internal readonly struct ExpressionValue(ValueType type, object? data = null, double number = 0, string? written = null)
{
    public readonly ValueType Type = type;
    public readonly object? Data = data;
    public readonly double Number = number;
    public readonly string? Written = written;
    public static readonly ValueType NumberType = new("number");
    public static readonly ValueType BooleanType = new("boolean");
    public static readonly ValueType StringType = new("string");
    public static readonly ValueType NullType = new("null");
    public static readonly ValueType AbsentType = new("absent");
    public static readonly ValueType InvalidType = new("invalid");
    public static readonly object AbsentStorage = new();
    public static readonly object InvalidStorage = new();
    public static ExpressionValue Null => new(NullType);
    public static ExpressionValue Absent => new(AbsentType);
    public static ExpressionValue Invalid => new(InvalidType);
    public static ExpressionValue Numeric(double number) => double.IsFinite(number) ? new(NumberType, number: number) : Invalid;
    public static ExpressionValue Boolean(bool value) => new(BooleanType, number: value ? 1 : 0);
    public static ExpressionValue Text(string value) => new(StringType, value);
    public bool IsInvalid => Type.Kind == "invalid";
    public bool IsAbsent => Type.Kind == "absent";
    public bool IsNull => Type.Kind == "null";
    public bool IsDimension => Type.Kind is "length" or "percentage" or "duration";
    public bool IsNumeric => Type.Kind is "number" or "integer";
    public bool IsText => Type.Kind is "string" or "keyword";
    public bool IsScalar => IsNumeric || IsText || IsDimension || Type.Kind is "boolean" or "null";
    public int Count => Data switch { object?[] values => values.Length, ExpressionValue[] values => values.Length, string text => text.Length, _ => 0 };
    public bool Truthy => Type.Kind switch
    {
        "null" or "absent" or "invalid" => false,
        "boolean" or "number" or "integer" => Number != 0,
        "list" or "object" or "string" or "keyword" => Count > 0,
        _ => IsDimension,
    };

    public static ExpressionValue Stored(object? data, ValueType type)
    {
        var value = StoredValue(data, type);
        return type.Reference ? type.CheckReference(value) : value;
    }

    internal static ExpressionValue StoredValue(object? data, ValueType type)
    {
        if (data is ExpressionValue value) return value;
        if (data is null) return Null;
        if (ReferenceEquals(data, AbsentStorage)) return Absent;
        if (ReferenceEquals(data, InvalidStorage)) return Invalid;
        if (data is double number) return Numeric(number);
        if (data is sbyte or byte or short or ushort or int or uint or long or ulong or float or decimal)
            return Numeric(Convert.ToDouble(data, CultureInfo.InvariantCulture));
        if (data is bool boolean) return Boolean(boolean);
        if (type.Kind is "length" or "percentage" or "duration" && data is string text)
            return type.Kind == "length" && text == "0" ? Text("0")
                : Dimensions.TryParse(text, out var quantity) && quantity.Type.Kind == type.Kind ? quantity : Invalid;
        if (data is string scalarText) return new(type.Kind == "keyword" ? type : StringType, scalarText);
        return new(type, data);
    }

    public object? Store() => Type.Kind switch
    {
        "null" => null, "absent" => AbsentStorage, "invalid" => InvalidStorage,
        "number" or "integer" => Number, "boolean" => Number != 0,
        "string" or "keyword" => Data,
        _ => this,
    };

    public ExpressionValue Item(int index) => ItemValue(index, true);
    public ExpressionValue ItemUnchecked(int index) => ItemValue(index, false);
    private ExpressionValue ItemValue(int index, bool conform)
    {
        if ((uint)index >= (uint)Count) return Absent;
        var declared = Type.Kind == "list" ? Type.Item! : Type.Fields![index].Type;
        var value = Data switch
        {
            ExpressionValue[] values => values[index],
            object?[] values => StoredValue(values[index], declared.Reference && values[index] is not object?[] ? UnknownStoredType : declared),
            _ => Absent,
        };
        return conform ? declared.CheckReference(value) : declared.ReferenceValue(value);
    }
    private static readonly ValueType UnknownStoredType = new("unknown");

    public ExpressionValue Member(string key) => MemberValue(key, true);
    public ExpressionValue MemberUnchecked(string key) => MemberValue(key, false);
    private ExpressionValue MemberValue(string key, bool conform)
    {
        if (IsInvalid) return Invalid;
        if (key == "length" && (Type.Kind == "list" || IsText)) return Numeric(Count);
        if (Type.Kind == "list") return CanonicalIndex(key, out var index) ? ItemValue(index, conform) : Absent;
        if (Type.Kind != "object") return Absent;
        var fields = Type.Fields!;
        for (var index = 0; index < fields.Length; index++) if (fields[index].Name == key) return ItemValue(index, conform);
        return Absent;
    }

    public static bool CanonicalIndex(string key, out int index) => int.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out index)
        && (key == "0" || !key.StartsWith('0'));

    public void Write(ref HtmlWriter writer, bool attribute)
    {
        if (IsNumeric) HtmlOutput.Number(ref writer, Number);
        else if (Type.Kind == "boolean") writer.Write(Number != 0 ? "true" : "false");
        else if (IsDimension)
        {
            if (Written is not null) writer.Write(Written);
            else { HtmlOutput.Number(ref writer, Number); writer.Write((string)Data!); }
        }
        else if (IsText) HtmlOutput.Escape(ref writer, (string)Data!, attribute);
    }

    public string ScalarText()
    {
        if (IsText) return (string)Data!;
        if (IsDimension && Written is not null) return Written;
        var counter = HtmlWriter.Counter();
        WriteRaw(ref counter);
        return string.Create(counter.Length, this, static (span, value) => { var writer = new HtmlWriter(span); value.WriteRaw(ref writer); });
    }

    private void WriteRaw(ref HtmlWriter writer)
    {
        if (IsText) writer.Write((string)Data!); else Write(ref writer, false);
    }
}

internal abstract record ValueExpression(ValueType Type)
{
    public abstract ExpressionValue Evaluate(object?[] values);
    public virtual ExpressionValue EvaluateUnchecked(object?[] values) => Evaluate(values);
    public virtual ExpressionValue OutputStatus(object?[] values) => Evaluate(values);
    public virtual bool Constant => false;
    public virtual void Write(ref HtmlWriter writer, object?[] values, bool attribute) => Evaluate(values).Write(ref writer, attribute);
}

internal sealed class ExpressionStorage
{
    public int Slot { get; private set; } = -1;
    public int Length { get; private set; }
    public void AssignSlot(int slot) => Slot = slot;
    public int Reserve(int count)
    {
        var offset = Length;
        Length = checked(Length + count);
        return offset;
    }
}

internal sealed record NumericBinaryExpression(string Operator, ValueExpression Left, ValueExpression Right) : ValueExpression(ExpressionValue.NumberType)
{
    public override bool Constant => Left.Constant && Right.Constant;
    public override ExpressionValue Evaluate(object?[] values)
    {
        var a = Left.Evaluate(values); var b = Right.Evaluate(values);
        if (a.IsInvalid || b.IsInvalid) return ExpressionValue.Invalid;
        if (!a.IsNumeric || !b.IsNumeric) return ExpressionValue.Absent;
        return ExpressionValue.Numeric(DecimalMath.Calculate(Operator, a.Number, b.Number));
    }
}

internal sealed record ConstantExpression : ValueExpression
{
    public ConstantExpression(ExpressionValue value, ValueType? declaredType = null) : base(declaredType ?? value.Type) => Value = value;
    public ExpressionValue Value { get; }
    public override bool Constant => true;
    public override ExpressionValue Evaluate(object?[] values) => Value;
}

internal sealed record PathExpression(BoundPath Path) : ValueExpression(Path.Type)
{
    public override ExpressionValue Evaluate(object?[] values) => Type.Reference ? Path.ReadReference(values, true) : ExpressionValue.Stored(Path.Read(values), Type);
    public override ExpressionValue EvaluateUnchecked(object?[] values) => Type.Reference ? Path.ReadReference(values, false) : Evaluate(values);
}

internal sealed record MemberExpression(ValueExpression Object, string Key, ValueType ResultType) : ValueExpression(ResultType)
{
    public override bool Constant => Object.Constant;
    public override ExpressionValue Evaluate(object?[] values) => Type.CheckReference(Object.EvaluateUnchecked(values).Member(Key));
    public override ExpressionValue EvaluateUnchecked(object?[] values) => Type.ReferenceValue(Object.EvaluateUnchecked(values).MemberUnchecked(Key));
}

internal sealed record IndexExpression(ValueExpression Object, ValueExpression Index, ValueType ResultType) : ValueExpression(ResultType)
{
    public override bool Constant => Object.Constant && Index.Constant;
    public override ExpressionValue Evaluate(object?[] values) => EvaluateMember(values, true);
    public override ExpressionValue EvaluateUnchecked(object?[] values) => EvaluateMember(values, false);
    private ExpressionValue EvaluateMember(object?[] values, bool conform)
    {
        var target = Object.EvaluateUnchecked(values);
        var index = Index.Evaluate(values);
        if (target.IsInvalid || index.IsInvalid) return ExpressionValue.Invalid;
        if (index.IsAbsent || index.IsNull) return ExpressionValue.Absent;
        if (index.IsText)
            return conform ? Type.CheckReference(target.Member((string)index.Data!)) : Type.ReferenceValue(target.MemberUnchecked((string)index.Data!));
        if (!index.IsNumeric) return ExpressionValue.Absent;
        if (target.Type.Kind == "list") return index.Number is >= 0 and <= int.MaxValue && Math.Truncate(index.Number) == index.Number
            ? conform ? Type.CheckReference(target.Item((int)index.Number)) : Type.ReferenceValue(target.ItemUnchecked((int)index.Number)) : ExpressionValue.Absent;
        var key = index.ScalarText();
        return conform ? Type.CheckReference(target.Member(key)) : Type.ReferenceValue(target.MemberUnchecked(key));
    }
}

internal sealed record UnaryExpression(string Operator, ValueExpression Operand, ValueType ResultType) : ValueExpression(ResultType)
{
    public override bool Constant => Operand.Constant;
    public override ExpressionValue Evaluate(object?[] values)
    {
        var value = Operand.Evaluate(values);
        if (value.IsInvalid) return value;
        if (Operator == "not") return ExpressionValue.Boolean(!value.Truthy);
        if (value.IsAbsent || value.IsNull) return ExpressionValue.Absent;
        return value.IsDimension ? new(value.Type, value.Data, -value.Number) : value.IsNumeric ? ExpressionValue.Numeric(-value.Number) : ExpressionValue.Invalid;
    }
}

internal sealed record ConditionalExpression(ValueExpression Test, ValueExpression Yes, ValueExpression No, ValueType ResultType) : ValueExpression(ResultType)
{
    public override bool Constant => Test.Constant && Yes.Constant && No.Constant;
    public override ExpressionValue Evaluate(object?[] values)
    {
        var test = Test.Evaluate(values);
        return test.IsInvalid ? test : (test.Truthy ? Yes : No).Evaluate(values);
    }
}

internal sealed record BinaryExpression(string Operator, ValueExpression Left, ValueExpression Right, ValueType ResultType) : ValueExpression(ResultType)
{
    public override bool Constant => Left.Constant && Right.Constant;
    public override ExpressionValue Evaluate(object?[] values)
    {
        var left = Left.Evaluate(values);
        if (left.IsInvalid) return left;
        if (Operator == "and" && !left.Truthy) return ExpressionValue.Boolean(false);
        if (Operator == "or" && left.Truthy) return ExpressionValue.Boolean(true);
        var right = Right.Evaluate(values);
        if (right.IsInvalid) return right;
        if (Operator is "and" or "or") return ExpressionValue.Boolean(right.Truthy);
        if (left.IsAbsent || right.IsAbsent) return ExpressionValue.Absent;
        if (Operator is "=" or "!=")
        {
            var equal = (left.Type.Kind == right.Type.Kind || left.IsText && right.IsText) && (left.IsNumeric || left.Type.Kind == "boolean" ? left.Number == right.Number
                : left.IsText ? string.Equals((string?)left.Data, (string?)right.Data, StringComparison.Ordinal)
                : left.IsDimension ? left.ScalarText() == right.ScalarText() : ReferenceEquals(left.Data, right.Data));
            return ExpressionValue.Boolean(Operator == "=" ? equal : !equal);
        }
        if (Operator is "^=" or "$=" or "*=")
        {
            if (!left.IsText || !right.IsText) return ExpressionValue.Absent;
            var a = (string)left.Data!; var b = (string)right.Data!;
            return ExpressionValue.Boolean(Operator == "^=" ? a.StartsWith(b, StringComparison.Ordinal)
                : Operator == "$=" ? a.EndsWith(b, StringComparison.Ordinal) : a.Contains(b, StringComparison.Ordinal));
        }
        if (left.IsNull || right.IsNull) return ExpressionValue.Absent;
        if (Operator is "<" or "<=" or ">" or ">=")
        {
            if (!left.IsNumeric || !right.IsNumeric) return ExpressionValue.Absent;
            return ExpressionValue.Boolean(Operator switch { "<" => left.Number < right.Number, "<=" => left.Number <= right.Number,
                ">" => left.Number > right.Number, _ => left.Number >= right.Number });
        }
        if (left.IsNumeric && right.IsNumeric) return ExpressionValue.Numeric(DecimalMath.Calculate(Operator, left.Number, right.Number));
        if (Operator is "+" or "-" && left.IsDimension && right.Type.Kind == left.Type.Kind && Equals(left.Data, right.Data))
            return DimensionResult(left, DecimalMath.Calculate(Operator, left.Number, right.Number));
        if (Operator == "*" && left.IsDimension && right.IsNumeric) return DimensionResult(left, DecimalMath.Calculate("*", left.Number, right.Number));
        if (Operator == "*" && right.IsDimension && left.IsNumeric) return DimensionResult(right, DecimalMath.Calculate("*", left.Number, right.Number));
        if (Operator == "/" && left.IsDimension && right.IsNumeric) return DimensionResult(left, left.Number / right.Number);
        return ExpressionValue.Invalid;
    }

    internal static ExpressionValue DimensionResult(ExpressionValue value, double number) => double.IsFinite(number)
        ? new(value.Type, value.Data, number) : ExpressionValue.Invalid;
}

internal sealed record ArrayExpression(ValueExpression[] Items, ValueType ResultType) : ValueExpression(ResultType)
{
    public override bool Constant => Items.All(item => item.Constant);
    public override ExpressionValue Evaluate(object?[] values)
    {
        var result = new ExpressionValue[Items.Length];
        for (var i = 0; i < result.Length; i++)
        {
            result[i] = Items[i].Evaluate(values);
            if (result[i].IsInvalid) return ExpressionValue.Invalid;
        }
        return new(Type, result);
    }
}

internal sealed record ObjectExpression(ValueExpression[] Fields, ValueType ResultType) : ValueExpression(ResultType)
{
    public override bool Constant => Fields.All(entry => entry.Constant);
    public override ExpressionValue Evaluate(object?[] values)
    {
        var result = new ExpressionValue[Fields.Length];
        for (var i = 0; i < result.Length; i++)
        {
            result[i] = Fields[i].Evaluate(values);
            if (result[i].IsInvalid) return ExpressionValue.Invalid;
        }
        return new(Type, result);
    }
}

internal sealed record CallExpression(string Name, ValueExpression[] Arguments, ValueType ResultType) : ValueExpression(ResultType)
{
    public ExpressionStorage? Storage { get; init; }
    public int Offset { get; init; }
    public override bool Constant => Arguments.All(argument => argument.Constant);
    public override ExpressionValue OutputStatus(object?[] values)
    {
        if (Name is not ("concat" or "join")) return Evaluate(values);
        var buffer = Fill(values);
        return BufferStatus(buffer.AsSpan(Storage is null ? 0 : Offset, Arguments.Length));
    }
    public override ExpressionValue Evaluate(object?[] values)
    {
        if (Name is "concat" or "join")
        {
            var buffer = Fill(values);
            var offset = Storage is null ? 0 : Offset;
            var status = BufferStatus(buffer.AsSpan(offset, Arguments.Length));
            if (!status.IsText) return status;
            var counter = HtmlWriter.Counter();
            WriteBuffer(ref counter, buffer.AsSpan(offset, Arguments.Length), false, true);
            return ExpressionValue.Text(string.Create(counter.Length, (Call: this, Buffer: buffer, Offset: offset), static (span, state) =>
            {
                var writer = new HtmlWriter(span);
                state.Call.WriteBuffer(ref writer, state.Buffer.AsSpan(state.Offset, state.Call.Arguments.Length), false, true);
            }));
        }
        var first = Arguments[0].Evaluate(values);
        if (Name == "default") return first.IsNull || first.IsAbsent ? Arguments[1].Evaluate(values) : first;
        if (first.IsInvalid) return first;
        if (first.IsAbsent || first.IsNull) return ExpressionValue.Absent;
        if (!first.IsNumeric && !first.IsDimension) return ExpressionValue.Invalid;
        var value = first.Number;
        if (Name == "abs") value = Math.Abs(value);
        else if (Name == "round")
        {
            var step = Arguments.Length == 1 ? new ExpressionValue(first.Type, first.Data, 1) : Arguments[1].Evaluate(values);
            if (step.IsInvalid) return step;
            if (step.IsNull || step.IsAbsent) return ExpressionValue.Absent;
            if (!SameUnits(first, step)) return ExpressionValue.Invalid;
            var scale = Math.Abs(step.Number);
            value = scale == 0 ? double.NaN : Math.Floor(value / scale + 0.5) * scale;
        }
        else
        {
            var minimum = value; var maximum = value; var middle = value;
            for (var i = 1; i < Arguments.Length; i++)
            {
                var next = Arguments[i].Evaluate(values);
                if (next.IsInvalid) return next;
                if (next.IsAbsent || next.IsNull) return ExpressionValue.Absent;
                if (!SameUnits(first, next)) return ExpressionValue.Invalid;
                minimum = Math.Min(minimum, next.Number); maximum = Math.Max(maximum, next.Number);
                if (i == 1) middle = next.Number;
                if (Name == "clamp" && i == 2) value = Math.Max(first.Number, Math.Min(middle, next.Number));
            }
            if (Name == "min") value = minimum;
            if (Name == "max") value = maximum;
        }
        return first.IsDimension ? BinaryExpression.DimensionResult(first, value) : ExpressionValue.Numeric(value);
    }

    private static bool SameUnits(ExpressionValue a, ExpressionValue b) => a.IsNumeric && b.IsNumeric
        || a.IsDimension && a.Type.Kind == b.Type.Kind && Equals(a.Data, b.Data);

    private ExpressionValue[] Fill(object?[] values)
    {
        var buffer = Storage is null ? new ExpressionValue[Arguments.Length] : (ExpressionValue[])values[Storage.Slot]!;
        var offset = Storage is null ? 0 : Offset;
        for (var index = 0; index < Arguments.Length; index++) buffer[offset + index] = Arguments[index].Evaluate(values);
        return buffer;
    }

    private ExpressionValue BufferStatus(scoped ReadOnlySpan<ExpressionValue> arguments)
    {
        var status = ExpressionValue.Text("");
        for (var index = 0; index < arguments.Length; index++)
        {
            var value = arguments[index];
            if (value.IsInvalid) return value;
            if (value.IsAbsent) status = value;
            if (Name == "concat" && !value.IsScalar && !value.IsAbsent) return ExpressionValue.Invalid;
            if (Name == "join" && index == 0)
            {
                if (value.Type.Kind != "list") return value.IsAbsent ? value : ExpressionValue.Invalid;
                string? itemType = null;
                for (var at = 0; at < value.Count; at++)
                {
                    var item = value.Item(at);
                    if (item.IsInvalid || !item.IsScalar && !item.IsAbsent) return ExpressionValue.Invalid;
                    if (item.IsAbsent) status = item;
                    if (item.IsNull || item.IsAbsent) continue;
                    var kind = item.IsNumeric ? "number" : item.IsDimension || item.IsText ? "string" : item.Type.Kind;
                    if (itemType is not null && itemType != kind) return ExpressionValue.Invalid;
                    itemType = kind;
                }
            }
            if (Name == "join" && index == 1 && !value.IsText && !value.IsAbsent) return ExpressionValue.Invalid;
        }
        return status;
    }

    private void WriteBuffer(ref HtmlWriter writer, scoped ReadOnlySpan<ExpressionValue> arguments, bool attribute, bool raw)
    {
        if (Name == "concat") foreach (var value in arguments) WriteScalar(ref writer, value, attribute, raw);
        else
        {
            var list = arguments[0]; var separator = arguments[1];
            for (var index = 0; index < list.Count; index++)
            {
                if (index > 0) WriteScalar(ref writer, separator, attribute, raw);
                WriteScalar(ref writer, list.Item(index), attribute, raw);
            }
        }
    }

    public override void Write(ref HtmlWriter writer, object?[] values, bool attribute)
    {
        if (Name is not ("concat" or "join")) { base.Write(ref writer, values, attribute); return; }
        var buffer = Fill(values).AsSpan(Storage is null ? 0 : Offset, Arguments.Length);
        if (BufferStatus(buffer).IsText) WriteBuffer(ref writer, buffer, attribute, false);
    }

    public void WriteUrlAttribute(ref HtmlWriter writer, object?[] values, string name, string source, string? fallback = null)
    {
        var buffer = Fill(values).AsSpan(Storage is null ? 0 : Offset, Arguments.Length);
        var status = BufferStatus(buffer);
        if (!status.IsText) { BoundAttribute.WriteFallback(ref writer, status, fallback, source); return; }
        if (BoundAttribute.ExecutableUrlParts(buffer, Name == "join", source)) return;
        BoundAttribute.Open(ref writer, name);
        WriteBuffer(ref writer, buffer, true, false);
        writer.Write('"');
    }

    private static void WriteScalar(ref HtmlWriter writer, ExpressionValue value, bool attribute, bool raw)
    {
        if (raw && value.IsText) writer.Write((string)value.Data!); else value.Write(ref writer, attribute);
    }
}

internal static class DecimalMath
{
    private static readonly double[] Powers = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];
    private static double Power(int places) => (uint)places < (uint)Powers.Length ? Powers[places] : Math.Pow(10, places);
    private static double Round(double value) => Math.Floor(value + 0.5);
    private static int Places(double value)
    {
        if (Math.Truncate(value) == value) return 0;
        for (var i = 1; i <= 22; i++) { var scale = Powers[i]; if (Round(value * scale) / scale == value) return i; }
        var text = value.ToString("R", CultureInfo.InvariantCulture);
        var exponentAt = text.IndexOfAny(['e', 'E']);
        var exponent = exponentAt < 0 ? 0 : int.Parse(text.AsSpan(exponentAt + 1), CultureInfo.InvariantCulture);
        var end = exponentAt < 0 ? text.Length : exponentAt;
        var dot = text.IndexOf('.');
        return Math.Max(0, (dot < 0 ? 0 : end - dot - 1) - exponent);
    }
    public static double Calculate(string op, double a, double b)
    {
        var result = op switch { "+" => a + b, "-" => a - b, "*" => a * b, "/" => a / b, "%" => a % b, _ => double.NaN };
        if (op == "/" || !double.IsFinite(result)) return result;
        var left = Places(a); var right = Places(b);
        var places = op == "*" ? left + right : Math.Max(left, right);
        if (!(places > 0 && Math.Max(Math.Max(Math.Abs(a), Math.Abs(b)), Math.Abs(result)) * Power(places) < 1e15)) return result;
        if (op != "*") left = right = places;
        var x = Round(a * Power(left)); var y = Round(b * Power(right));
        var integer = op switch { "+" => x + y, "-" => x - y, "*" => x * y, _ => x % y };
        return places > 22 && integer != 0 ? double.Parse(integer.ToString("R", CultureInfo.InvariantCulture) + "e-" + places, CultureInfo.InvariantCulture)
            : integer / Power(places);
    }
}

internal static class Dimensions
{
    private static readonly ValueType Length = new("length"), Duration = new("duration"), Percentage = new("percentage");
    private static readonly string[] Units = ["vmin", "vmax", "rem", "px", "em", "vw", "vh", "ch", "ex", "cm", "mm", "in", "pt", "pc", "q", "ms", "s", "%"];
    public static bool TryParse(string text, out ExpressionValue value)
    {
        foreach (var character in text) if (char.IsWhiteSpace(character)) { value = ExpressionValue.Invalid; return false; }
        foreach (var unit in Units) if (text.EndsWith(unit, StringComparison.Ordinal)
            && double.TryParse(text.AsSpan(0, text.Length - unit.Length), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number))
        {
            value = new(unit == "%" ? Percentage : unit is "ms" or "s" ? Duration : Length, unit, number, text);
            return true;
        }
        value = ExpressionValue.Invalid;
        return false;
    }
}
