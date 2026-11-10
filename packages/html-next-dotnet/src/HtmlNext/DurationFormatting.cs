using System.Globalization;
using System.Numerics;
using System.Text.RegularExpressions;

namespace HtmlNext;

// Compose ICU number fields and unit-list boundaries. Validate the normalized bound in
// integer nanounits; formatting retains the supported JavaScript host's Number conversion.
internal sealed class DurationFormatting(ExpressionValue options)
{
    private static readonly string[] Units = ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds", "microseconds", "nanoseconds"];
    private static readonly BigInteger Billion = 1_000_000_000;
    private readonly string[] styles = new string[10];
    private readonly bool[] always = new bool[10];
    private readonly BigInteger[] values = new BigInteger[10];
    private readonly double[] numbers = new double[10];
    private bool valid = true;
    private bool negative;
    private int fractionDigits = -1;
    private ExpressionValue Get(string key) => options.Member(key);
    private string Choice(string key, string fallback, params string[] choices)
    {
        var value = Get(key);
        if (value.IsAbsent) return fallback;
        var text = NumberFormatting.String(value);
        if (!choices.Contains(text, StringComparer.Ordinal)) valid = false;
        return text;
    }
    internal static ExpressionValue Evaluate(IcuFormatters icu, ExpressionValue input, string? kind, ExpressionValue options, string? locale, bool parts)
        => new DurationFormatting(options).Format(icu, input, kind, locale, parts);

    private ExpressionValue Format(IcuFormatters icu, ExpressionValue input, string? kind, string? locale, bool parts)
    {
        Choice("localeMatcher", "best fit", "lookup", "best fit");
        var style = Choice("style", "short", "long", "short", "narrow", "digital");
        var previous = "";
        for (var index = 0; index < Units.Length; index++)
        {
            var authored = Get(Units[index]);
            var unitStyle = authored.IsAbsent ? style == "digital" ? index < 4 ? "short" : "numeric"
                : previous is "numeric" or "2-digit" or "fractional" ? "numeric" : style : NumberFormatting.String(authored);
            if (unitStyle is not ("long" or "short" or "narrow") && (index < 4 || unitStyle != "numeric" && (index > 6 || unitStyle != "2-digit"))) valid = false;
            var show = !authored.IsAbsent || (style == "digital" || previous is "numeric" or "2-digit" or "fractional") && index is >= 4 and <= 6;
            if (index >= 7 && unitStyle == "numeric") { unitStyle = "fractional"; show = false; }
            show = Choice(Units[index] + "Display", show ? "always" : "auto", "auto", "always") == "always";
            if (unitStyle == "fractional" && show || previous == "fractional" && unitStyle != "fractional"
                || previous is "numeric" or "2-digit" && unitStyle is not ("numeric" or "2-digit" or "fractional")) valid = false;
            if (index is 5 or 6 && previous is "numeric" or "2-digit") unitStyle = "2-digit";
            styles[index] = unitStyle; always[index] = show;
            if (index is >= 4 and <= 8) previous = unitStyle;
        }
        if (!Get("fractionalDigits").IsAbsent)
        {
            var digits = NumberFormatting.Number(Get("fractionalDigits"));
            if (!double.IsFinite(digits) || digits < 0 || digits > 9) valid = false;
            else fractionDigits = (int)Math.Floor(digits);
        }
        if (!Get("numberingSystem").IsAbsent)
        {
            var system = NumberFormatting.String(Get("numberingSystem"));
            if (!Regex.IsMatch(system, @"\A[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8})*\z", RegexOptions.CultureInvariant)) valid = false;
            else if (icu.HasNumberingSystem(system)) locale = icu.LocaleKeyword(locale, "numbers", system);
        }
        if (!valid || !Record(input, kind)) return ExpressionValue.Invalid;
        var groups = new List<ExpressionValue[]>();
        var first = true;
        for (var index = 0; index < Units.Length; index++)
        {
            if (styles[index] is "numeric" or "2-digit")
            {
                var digital = new List<ExpressionValue>();
                var seconds = Quantity(6);
                var hoursShown = index == 4 && (values[4] != 0 || always[4]);
                var secondsShown = seconds != 0 || always[6];
                var minutesShown = index <= 5 && (hoursShown && secondsShown || values[5] != 0 || always[5]);
                var separator = icu.DurationSeparator(locale);
                foreach (var unit in new[] { 4, 5, 6 })
                {
                    if (!(unit == 4 ? hoursShown : unit == 5 ? minutesShown : secondsShown)) continue;
                    if (digital.Count > 0) digital.Add(new(IcuFormatters.PartType, new[] { ExpressionValue.Text("literal"), ExpressionValue.Text(separator) }));
                    if (!NumberParts(icu, locale, unit, true, unit == 6, first, out var formatted)) return ExpressionValue.Invalid;
                    digital.AddRange(formatted); first = false;
                }
                if (digital.Count > 0)
                {
                    // The supported host joins a numeric seconds field to the preceding clock unit.
                    if (index == 6 && groups.Count > 0)
                        groups[^1] = groups[^1].Concat([new ExpressionValue(IcuFormatters.PartType, new[] { ExpressionValue.Text("literal"), ExpressionValue.Text(separator) })]).Concat(digital).ToArray();
                    else groups.Add(digital.ToArray());
                }
                break;
            }
            var fractional = index < 9 && styles[index + 1] == "fractional";
            var quantity = fractional ? Quantity(index) : values[index] * Billion;
            if (quantity != 0 || always[index])
            {
                if (!NumberParts(icu, locale, index, false, fractional, first, out var formatted)) return ExpressionValue.Invalid;
                groups.Add(formatted); first = false;
            }
            if (fractional) break;
        }
        var strings = groups.Select(group => string.Concat(group.Select(part => part.Member("value").ScalarText()))).ToArray();
        if (!icu.FormatList(locale, 2, style switch { "long" => 0, "narrow" => 2, _ => 1 }, strings, true, out var joined)) return ExpressionValue.Invalid;
        var output = new List<ExpressionValue>();
        var groupIndex = 0;
        for (var index = 0; index < joined.Count; index++)
        {
            var part = joined.Item(index);
            if (part.Member("type").ScalarText() == "element")
            {
                var text = part.Member("value").ScalarText();
                var original = strings[groupIndex];
                var start = text.IndexOf(original, StringComparison.Ordinal);
                if (start < 0) return ExpressionValue.Invalid;
                void Literal(string value) => output.Add(new(IcuFormatters.PartType, new[] { ExpressionValue.Text("literal"), ExpressionValue.Text(value) }));
                if (start > 0) Literal(text[..start]);
                output.AddRange(groups[groupIndex++]);
                if (start + original.Length < text.Length) Literal(text[(start + original.Length)..]);
            }
            else output.Add(part);
        }
        return parts ? new(IcuFormatters.PartsType, output.ToArray()) : ExpressionValue.Text(string.Concat(output.Select(part => part.Member("value").ScalarText())));
    }

    private bool Record(ExpressionValue input, string? kind)
    {
        if (kind == "duration" && input.Type.Kind == "duration")
        {
            var match = Regex.Match(input.ScalarText(), @"\A(-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))(ms|s)\z", RegexOptions.CultureInvariant);
            if (!match.Success) return false;
            var ms = input.Number * (match.Groups[2].Value == "s" ? 1000 : 1);
            if (!double.IsFinite(ms)) return false;
            numbers[4] = Math.Truncate(ms / 3_600_000);
            numbers[5] = Math.Truncate(ms % 3_600_000 / 60_000);
            numbers[6] = Math.Truncate(ms % 60_000 / 1000);
            numbers[7] = Math.Truncate(ms % 1000);
            numbers[8] = Math.Truncate((ms - Math.Truncate(ms)) * 1000);
            numbers[9] = Math.Floor((ms * 1000 - Math.Truncate(ms * 1000)) * 1000 + 0.5);
        }
        else
        {
            if (input.Type.Kind != "object" || input.Type.Fields!.Length == 0 || input.Type.Fields.Any(field => !Units.Contains(field.Name, StringComparer.Ordinal))) return false;
            var found = false;
            for (var index = 0; index < Units.Length; index++)
            {
                var value = input.Member(Units[index]);
                if (value.IsAbsent) continue;
                found = true;
                var number = NumberFormatting.Number(value);
                numbers[index] = double.IsNaN(number) ? 0 : number;
            }
            if (!found) return false;
        }
        var sign = 0;
        for (var index = 0; index < numbers.Length; index++)
        {
            var number = numbers[index];
            if (!double.IsFinite(number) || Math.Truncate(number) != number) return false;
            if (number != 0) { if (sign != 0 && Math.Sign(number) != sign) return false; sign = Math.Sign(number); }
            values[index] = new BigInteger(number);
            if (index < 3 && BigInteger.Abs(values[index]) >= BigInteger.One << 32) return false;
        }
        negative = sign < 0;
        var total = (values[3] * 86400 + values[4] * 3600 + values[5] * 60 + values[6]) * Billion + values[7] * 1_000_000 + values[8] * 1000 + values[9];
        return BigInteger.Abs(total) < (BigInteger.One << 53) * Billion;
    }
    private BigInteger Quantity(int unit)
    {
        var result = values[unit] * Billion;
        var exponent = 6;
        for (var index = 7; index < Units.Length; index++) if (styles[index] == "fractional") { result += values[index] * BigInteger.Pow(10, exponent); exponent -= 3; }
        return result;
    }
    private bool NumberParts(IcuFormatters icu, string? locale, int unit, bool numeric, bool fractional, bool first, out ExpressionValue[] output)
    {
        output = [];
        var name = Units[unit][..^1];
        var skeleton = (first ? "sign-auto " : "sign-never ") + (numeric ? "group-off " : "group-auto measure-unit/duration-" + name + " " + (styles[unit] switch { "long" => "unit-width-full-name ", "narrow" => "unit-width-narrow ", _ => "unit-width-short " }))
            + "integer-width/*" + (styles[unit] == "2-digit" ? "00 " : "0 ") + (fractional ? "rounding-mode-down ." + (fractionDigits < 0 ? "#########" : new string('0', fractionDigits)) : ".###");
        var number = numbers[unit];
        if (fractional)
        {
            var exponent = 3;
            var fraction = 0.0;
            for (var index = 7; index < Units.Length; index++) if (styles[index] == "fractional") { fraction += numbers[index] / Math.Pow(10, exponent); exponent += 3; }
            number += fraction;
        }
        if (number == 0) number = first && negative ? -0.0 : 0.0;
        var exact = number.ToString("R", CultureInfo.InvariantCulture);
        if (!icu.FormatDecimal(skeleton, locale, exact, out var formatted)) return false;
        output = Enumerable.Range(0, formatted.Count).Select(index =>
        {
            var part = formatted.Item(index);
            return new ExpressionValue(IcuFormatters.PartType, new[] { part.Member("type"), part.Member("value"), ExpressionValue.Text(name) });
        }).ToArray();
        return true;
    }
}
