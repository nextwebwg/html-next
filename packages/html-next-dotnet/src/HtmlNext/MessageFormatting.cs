using System.Text.RegularExpressions;

namespace HtmlNext;

internal sealed class MessageFormatting(ExpressionValue options)
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
    internal static ExpressionValue Evaluate(IcuFormatters icu, string operation, ExpressionValue value, string format, ExpressionValue options, string? locale)
        => new MessageFormatting(options).Format(icu, operation, value, format, locale);
    private ExpressionValue Format(IcuFormatters icu, string operation, ExpressionValue value, string format, string? locale)
    {
        Choice("localeMatcher", "best fit", "lookup", "best fit");
        var style = Choice("style", "long", "long", "short", "narrow");
        var width = style switch { "long" => 0, "short" => 1, _ => 2 };
        var parts = operation == "formatParts";
        if (format == "list")
        {
            var type = Choice("type", "conjunction", "conjunction", "disjunction", "unit");
            if (!valid || value.Type.Kind != "list") return ExpressionValue.Invalid;
            var items = new string[value.Count];
            for (var index = 0; index < items.Length; index++)
            {
                var item = value.Item(index);
                if (!item.IsText) return ExpressionValue.Invalid;
                items[index] = item.ScalarText();
            }
            return icu.FormatList(locale, type switch { "conjunction" => 0, "disjunction" => 1, _ => 2 }, width, items, parts, out var output)
                ? output : ExpressionValue.Invalid;
        }
        var numeric = Choice("numeric", "always", "always", "auto");
        if (!Get("numberingSystem").IsAbsent)
        {
            var system = NumberFormatting.String(Get("numberingSystem"));
            if (!Regex.IsMatch(system, @"\A[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8})*\z", RegexOptions.CultureInvariant)) valid = false;
            else if (icu.HasNumberingSystem(system)) locale = icu.LocaleKeyword(locale, "numbers", system);
        }
        var unit = Get("unit");
        if (!valid || !value.IsNumeric || !double.IsFinite(value.Number) || !unit.IsText) return ExpressionValue.Invalid;
        var name = unit.ScalarText();
        if (name.EndsWith('s')) name = name[..^1];
        var indexOfUnit = Array.IndexOf(new[] { "year", "quarter", "month", "week", "day", "hour", "minute", "second" }, name);
        return indexOfUnit >= 0 && icu.FormatRelative(locale, width, numeric == "auto", indexOfUnit, name, value.Number, parts, out var relative)
            ? relative : ExpressionValue.Invalid;
    }
}
