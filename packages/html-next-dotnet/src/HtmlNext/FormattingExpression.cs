using System.Globalization;

namespace HtmlNext;

internal sealed record FormattingExpression(string Operation, ValueExpression[] Arguments)
    : ValueExpression(Operation == "formatParts" ? IcuNumbers.PartsType : ExpressionValue.StringType)
{
    internal static string? InputKind(ValueType type) => type.Selection is { } selected ? selected.FormattingKind : type.Kind;

    public override ExpressionValue Evaluate(object?[] values)
    {
        var arguments = new ExpressionValue[Arguments.Length];
        var absent = false;
        var invalid = false;
        for (var index = 0; index < arguments.Length; index++)
        {
            arguments[index] = Arguments[index].Evaluate(values);
            invalid |= arguments[index].IsInvalid;
            absent |= arguments[index].IsAbsent;
        }
        if (invalid) return ExpressionValue.Invalid;
        if (absent) return ExpressionValue.Absent;
        var range = Operation == "formatRange";
        var required = range ? 2 : 1;
        if (arguments.Length < required) return ExpressionValue.Invalid;
        if (arguments[0].IsNull || range && arguments[1].IsNull) return ExpressionValue.Absent;
        var kind = InputKind(Arguments[0].Type);
        var offset = required;
        var format = offset < arguments.Length && arguments[offset].IsText ? arguments[offset++].ScalarText()
            : kind switch { "number" or "integer" => "number", "percentage" => "percent", _ => null };
        var options = offset < arguments.Length ? arguments[offset++] : new ExpressionValue(new("object", Fields: []), Array.Empty<ExpressionValue>());
        string? locale = null;
        if (offset < arguments.Length)
        {
            var language = arguments[offset++];
            if (!language.IsText) return ExpressionValue.Invalid;
            locale = language.ScalarText();
        }
        if (offset < arguments.Length || format is not ("number" or "currency" or "percent" or "unit") || options.Type.Kind != "object") return ExpressionValue.Invalid;
        var icu = IcuNumbers.Available;
        locale ??= CultureInfo.CurrentCulture.Name is { Length: > 0 } culture ? culture : null;
        if (icu is null || locale is not null && !icu.Locale(locale, out locale, !options.Member("numberingSystem").IsAbsent)) return ExpressionValue.Invalid;
        if (!Number(arguments[0], kind, out var first) || range && !Number(arguments[1], kind, out _)) return ExpressionValue.Invalid;
        double? last = null;
        if (range) { Number(arguments[1], kind, out var end); last = end; }
        if (!NumberFormatting.TrySkeleton(icu, format, options, out var skeleton)) return ExpressionValue.Invalid;
        return icu.Format(skeleton, locale, first, last, Operation == "formatParts", out var result) ? result : ExpressionValue.Invalid;
    }

    private static bool Number(ExpressionValue value, string? kind, out double number)
    {
        number = value.Number;
        if (value.IsNumeric) return double.IsFinite(number);
        if (kind != "percentage" || value.Type.Kind != "percentage") return false;
        number /= 100;
        return double.IsFinite(number);
    }
}
