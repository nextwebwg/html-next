using System.Text.RegularExpressions;

namespace HtmlNext;

internal sealed class NamePluralFormatting(ExpressionValue options)
{
    private bool valid = true;
    private ExpressionValue Get(string key) => options.Member(key);
    private string Choice(string key, string fallback, params string[] choices)
    {
        var value = Get(key);
        if (value.IsAbsent) return fallback;
        var text = NumberFormatting.String(value);
        if (!choices.Contains(text, StringComparer.Ordinal)) valid = false;
        return text;
    }
    internal static ExpressionValue Evaluate(IcuFormatters icu, ExpressionValue value, string format, ExpressionValue options, string? locale)
    {
        var operation = new NamePluralFormatting(options);
        operation.Choice("localeMatcher", "best fit", "lookup", "best fit");
        return format == "displayName" ? operation.Name(icu, value, locale) : operation.Plural(icu, value, locale);
    }
    private ExpressionValue Name(IcuFormatters icu, ExpressionValue value, string? locale)
    {
        var type = Choice("type", "", "language", "region", "script", "currency", "calendar", "dateTimeField");
        var style = Choice("style", "long", "long", "short", "narrow");
        var fallback = Choice("fallback", "code", "code", "none");
        var language = Choice("languageDisplay", "dialect", "dialect", "standard");
        if (!valid || type.Length == 0 || !value.IsText) return ExpressionValue.Invalid;
        var code = value.ScalarText();
        var original = code;
        switch (type)
        {
            case "language":
                if (code.Split('-').Any(part => part.Length == 1) || !icu.LanguageDisplayCode(code, out code)) return ExpressionValue.Invalid;
                break;
            case "region":
                if (!Regex.IsMatch(code, @"\A(?:[A-Za-z]{2}|[0-9]{3})\z", RegexOptions.CultureInvariant)) return ExpressionValue.Invalid;
                break;
            case "script":
                if (code.Length != 4 || !code.All(char.IsAsciiLetter)) return ExpressionValue.Invalid;
                break;
            case "currency":
                if (code.Length != 3 || !code.All(char.IsAsciiLetter)) return ExpressionValue.Invalid;
                original = code = code.ToUpperInvariant();
                break;
            case "calendar":
                if (!Regex.IsMatch(code, @"\A[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8})*\z", RegexOptions.CultureInvariant)) return ExpressionValue.Invalid;
                break;
        }
        if (!icu.DisplayName(locale, type, style, language == "dialect", fallback == "none", code, out var result)) return ExpressionValue.Invalid;
        return result is not null ? ExpressionValue.Text(result) : fallback == "none" ? ExpressionValue.Absent : ExpressionValue.Text(original);
    }
    private static readonly HashSet<string> Categories = new(["zero", "one", "two", "few", "many", "other"], StringComparer.Ordinal);
    private static readonly HashSet<string> PrecisionKeys = new(["minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits", "maximumSignificantDigits", "roundingIncrement", "roundingMode", "roundingPriority", "trailingZeroDisplay"], StringComparer.Ordinal);
    private ExpressionValue Plural(IcuFormatters icu, ExpressionValue value, string? locale)
    {
        var type = Choice("type", "cardinal", "cardinal", "ordinal");
        var forms = Get("forms");
        if (!valid || !value.IsNumeric || !double.IsFinite(value.Number) || forms.Type.Kind != "object" || !forms.Member("other").IsText) return ExpressionValue.Invalid;
        foreach (var field in forms.Type.Fields!) if (!Categories.Contains(field.Name) || !forms.Member(field.Name).IsText) return ExpressionValue.Invalid;
        var precisionFields = options.Type.Fields!.Where(field => PrecisionKeys.Contains(field.Name)).ToArray();
        var precision = new ExpressionValue(new("object", Fields: precisionFields), precisionFields.Select(field => Get(field.Name)).ToArray());
        if (!NumberFormatting.TrySkeleton(icu, "number", precision, out var ruleSkeleton)
            || !NumberFormatting.TrySkeleton(icu, "number", options, out var numberSkeleton)
            || !icu.PluralCategory(locale, type == "ordinal", ruleSkeleton, value.Number, out var category)
            || !icu.Format(numberSkeleton, locale, value.Number, null, false, out var number)) return ExpressionValue.Invalid;
        var message = forms.Member(category);
        if (message.IsAbsent) message = forms.Member("other");
        return ExpressionValue.Text(message.ScalarText().Replace("#", number.ScalarText(), StringComparison.Ordinal));
    }
}
