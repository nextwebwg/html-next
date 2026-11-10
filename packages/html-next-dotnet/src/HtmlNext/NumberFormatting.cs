using System.Globalization;
using System.Text.RegularExpressions;

namespace HtmlNext;

// Translate the NumberFormat constructor's options to ICU's public number skeleton grammar.
// ICU performs rounding and locale-sensitive layout, including parts and range identities.
internal sealed class NumberFormatting(ExpressionValue options)
{
    private bool valid = true;
    private ExpressionValue Get(string key) => options.Member(key);
    private bool Has(string key) => !Get(key).IsAbsent;
    private string Choice(string key, string fallback, params string[] choices)
    {
        var value = Get(key);
        if (value.IsAbsent) return fallback;
        var text = String(value);
        if (!choices.Contains(text, StringComparer.Ordinal)) valid = false;
        return text;
    }
    private int Digit(string key, int fallback, int minimum, int maximum)
    {
        var value = Get(key);
        if (value.IsAbsent) return fallback;
        var number = Number(value);
        if (!double.IsFinite(number) || number < minimum || number > maximum) { valid = false; return fallback; }
        return (int)Math.Floor(number);
    }
    internal static double Number(ExpressionValue value)
    {
        if (value.IsNumeric || value.Type.Kind == "boolean") return value.Number;
        if (value.IsNull) return 0;
        var text = String(value).Trim();
        if (text.Length == 0) return 0;
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) && ulong.TryParse(text.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var hex)) return hex;
        if (text.StartsWith("0b", StringComparison.OrdinalIgnoreCase) || text.StartsWith("0o", StringComparison.OrdinalIgnoreCase))
        {
            try { return Convert.ToUInt64(text[2..], char.ToLowerInvariant(text[1]) == 'b' ? 2 : 8); }
            catch (Exception error) when (error is FormatException or OverflowException or ArgumentException) { return double.NaN; }
        }
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ? number : double.NaN;
    }
    internal static string String(ExpressionValue value)
    {
        if (value.IsNull) return "null";
        if (value.IsAbsent) return "undefined";
        if (value.Type.Kind == "object") return "[object Object]";
        if (value.Type.Kind == "list") return string.Join(',', Enumerable.Range(0, value.Count).Select(index =>
        {
            var item = value.Item(index);
            return item.IsNull || item.IsAbsent ? "" : String(item);
        }));
        return value.ScalarText();
    }

    internal static bool TrySkeleton(IcuFormatters icu, string format, ExpressionValue options, out string skeleton)
        => new NumberFormatting(options).Build(icu, format, out skeleton);

    private bool Build(IcuFormatters icu, string format, out string skeleton)
    {
        skeleton = "";
        var tokens = new List<string>();
        Choice("localeMatcher", "best fit", "lookup", "best fit");
        var style = Choice("style", "decimal", "decimal", "currency", "percent", "unit");
        if (format != "number")
        {
            if (Has("style") && style != format) valid = false;
            style = format;
        }
        var currency = Has("currency") ? String(Get("currency")).ToUpperInvariant() : "";
        if (Has("currency") && (currency.Length != 3 || !currency.All(char.IsAsciiLetter))) valid = false;
        var currencyDisplay = Choice("currencyDisplay", "symbol", "code", "symbol", "narrowSymbol", "name");
        var accounting = Choice("currencySign", "standard", "standard", "accounting") == "accounting" && style == "currency";
        var unit = Has("unit") ? String(Get("unit")) : "";
        var unitDisplay = Choice("unitDisplay", "short", "short", "narrow", "long");
        if (Has("unit") && !Unit(unit, out _)) valid = false;
        if (style == "currency")
        {
            if (currency.Length == 0) valid = false;
            else tokens.Add("currency/" + currency);
            tokens.Add(currencyDisplay switch { "code" => "unit-width-iso-code", "narrowSymbol" => "unit-width-narrow", "name" => "unit-width-full-name", _ => "unit-width-short" });
        }
        else if (style == "percent") { tokens.Add("percent"); tokens.Add("scale/100"); }
        else if (style == "unit")
        {
            if (Unit(unit, out var units)) tokens.Add(units); else valid = false;
            tokens.Add(unitDisplay switch { "long" => "unit-width-full-name", "narrow" => "unit-width-narrow", _ => "unit-width-short" });
        }
        var notation = Choice("notation", "standard", "standard", "scientific", "engineering", "compact");
        var compactDisplay = Choice("compactDisplay", "short", "short", "long");
        if (notation != "standard") tokens.Add(notation == "compact" ? "compact-" + compactDisplay : notation);
        var sign = Choice("signDisplay", "auto", "auto", "never", "always", "exceptZero", "negative");
        tokens.Add((accounting, sign) switch
        {
            (_, "never") => "sign-never", (true, "always") => "sign-accounting-always", (true, "exceptZero") => "sign-accounting-except-zero",
            (true, "negative") => "sign-accounting-negative", (true, _) => "sign-accounting", (_, "always") => "sign-always",
            (_, "exceptZero") => "sign-except-zero", (_, "negative") => "sign-negative", _ => "sign-auto"
        });
        var grouping = Get("useGrouping");
        var groupDefault = notation == "compact" ? "min2" : "auto";
        var group = grouping.IsAbsent ? groupDefault : !grouping.Truthy && grouping.Type.Kind is not ("object" or "list") ? "off" : grouping.Type.Kind == "boolean" ? "always" : String(grouping);
        if (group is "true" or "false") group = groupDefault;
        tokens.Add(group switch { "off" => "group-off", "always" => "group-on-aligned", "min2" => "group-min2", _ => "group-auto" });
        if (group is not ("off" or "always" or "min2" or "auto")) valid = false;
        if (Has("numberingSystem"))
        {
            var system = String(Get("numberingSystem"));
            if (!Regex.IsMatch(system, "^[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8})*$", RegexOptions.CultureInvariant)) valid = false;
            else if (icu.HasNumberingSystem(system)) tokens.Add("numbering-system/" + system);
        }
        var minimumInteger = Digit("minimumIntegerDigits", 1, 1, 21);
        tokens.Add("integer-width/*" + new string('0', minimumInteger));
        var rounding = Choice("roundingMode", "halfExpand", "ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven");
        tokens.Add("rounding-mode-" + (rounding switch { "ceil" => "ceiling", "expand" => "up", "trunc" => "down", "halfCeil" => "half-ceiling", "halfFloor" => "half-floor", "halfExpand" => "half-up", "halfTrunc" => "half-down", "halfEven" => "half-even", _ => "floor" }));
        var priority = Choice("roundingPriority", "auto", "auto", "morePrecision", "lessPrecision");
        var trailing = Choice("trailingZeroDisplay", "auto", "auto", "stripIfInteger");
        var increment = Digit("roundingIncrement", 1, 1, 5000);
        if (!new[] { 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000 }.Contains(increment)) valid = false;
        var significant = Has("minimumSignificantDigits") || Has("maximumSignificantDigits");
        var fraction = Has("minimumFractionDigits") || Has("maximumFractionDigits");
        var needSignificant = priority != "auto" || significant;
        var needFraction = priority != "auto" || !significant && (fraction || notation != "compact");
        var defaultFraction = style == "currency" && currency.Length == 3 ? icu.CurrencyPrecision(currency) : 0;
        var defaultMaximum = style == "currency" ? defaultFraction : style == "percent" ? 0 : 3;
        // An unused precision family is not coerced or range checked by the constructor.
        var minFraction = needFraction ? Digit("minimumFractionDigits", defaultFraction, 0, 100) : defaultFraction;
        var maxFraction = needFraction ? Digit("maximumFractionDigits", defaultMaximum, 0, 100) : defaultMaximum;
        var minSignificant = needSignificant ? Digit("minimumSignificantDigits", 1, 1, 21) : 1;
        var maxSignificant = needSignificant ? Digit("maximumSignificantDigits", 21, 1, 21) : 21;
        if (needFraction)
        {
            if (!Has("minimumFractionDigits")) minFraction = Math.Min(defaultFraction, maxFraction);
            if (!Has("maximumFractionDigits")) maxFraction = Math.Max(defaultMaximum, minFraction);
            if (minFraction > maxFraction) valid = false;
        }
        if (needSignificant && minSignificant > maxSignificant) valid = false;
        if (!needFraction && !needSignificant) { minFraction = maxFraction = 0; minSignificant = 1; maxSignificant = 2; priority = "morePrecision"; needFraction = needSignificant = true; }
        var precision = "." + new string('0', minFraction) + new string('#', Math.Max(0, maxFraction - minFraction));
        var sigPrecision = new string('@', minSignificant) + new string('#', Math.Max(0, maxSignificant - minSignificant));
        if (increment != 1)
        {
            if (needSignificant || priority != "auto" || minFraction != maxFraction) valid = false;
            var written = increment.ToString(CultureInfo.InvariantCulture).PadLeft(maxFraction + 1, '0');
            precision = "precision-increment/" + (maxFraction == 0 ? written : written.Insert(written.Length - maxFraction, "."));
        }
        else if (needFraction && needSignificant) precision += "/" + sigPrecision + (priority == "morePrecision" ? "r" : "s");
        else if (needSignificant) precision = sigPrecision;
        if (trailing == "stripIfInteger") precision += "/w";
        tokens.Add(precision);
        skeleton = string.Join(' ', tokens);
        return valid;
    }

    private static readonly Dictionary<string, string> Units = new(StringComparer.Ordinal);
    static NumberFormatting()
    {
        foreach (var (family, names) in new (string, string)[]
        {
            ("area", "acre hectare"), ("digital", "bit byte gigabit gigabyte kilobit kilobyte megabit megabyte petabyte terabit terabyte"),
            ("temperature", "celsius fahrenheit"), ("length", "centimeter foot inch kilometer meter mile mile-scandinavian millimeter yard"),
            ("duration", "day hour microsecond millisecond minute month nanosecond second week year"), ("angle", "degree"),
            ("volume", "fluid-ounce gallon liter milliliter"), ("mass", "gram kilogram ounce pound stone"), ("concentr", "percent")
        }) foreach (var name in names.Split(' ')) Units.Add(name, family + "-" + name);
    }
    private static bool Unit(string name, out string skeleton)
    {
        var parts = name.Split("-per-", StringSplitOptions.None);
        skeleton = "";
        if (parts.Length is < 1 or > 2 || !Units.TryGetValue(parts[0], out var numerator)) return false;
        skeleton = "measure-unit/" + numerator;
        if (parts.Length == 1) return true;
        if (!Units.TryGetValue(parts[1], out var denominator)) return false;
        skeleton += " per-measure-unit/" + denominator;
        return true;
    }
}
