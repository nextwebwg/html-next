using System.Text.RegularExpressions;

namespace HtmlNext;

internal sealed record DateSettings(string? Locale, string? Zone, string Skeleton, int DateStyle, int TimeStyle, char Hour, bool Civil);

internal sealed class DateFormatting(ExpressionValue options)
{
    private bool valid = true;
    private ExpressionValue Get(string key) => options.Member(key);
    private bool Has(string key) => !Get(key).IsAbsent;
    private string Choice(string key, string fallback, params string[] choices)
    {
        var value = Get(key);
        if (value.IsAbsent) return fallback;
        var written = NumberFormatting.String(value);
        if (!choices.Contains(written, StringComparer.Ordinal)) valid = false;
        return written;
    }
    private string Width(string key, params string[] choices) => Choice(key, "", choices);
    internal static ExpressionValue Evaluate(IcuFormatters icu, string operation, ExpressionValue value, ExpressionValue? last, string? kind,
        string format, ExpressionValue options, string? locale)
    {
        var civil = DateValues.Civil(kind, value);
        var settings = new DateFormatting(options).Build(icu, format, locale, civil);
        if (settings is null || !DateValues.Epoch(value, format, out var first)) return ExpressionValue.Invalid;
        double? end = null;
        if (last is { } final)
        {
            if (!DateValues.Epoch(final, format, out var number)) return ExpressionValue.Invalid;
            end = number;
        }
        return icu.FormatDate(settings, first, end, operation == "formatParts", out var output) ? output : ExpressionValue.Invalid;
    }
    private DateSettings? Build(IcuFormatters icu, string format, string? locale, bool civil)
    {
        Choice("localeMatcher", "best fit", "lookup", "best fit");
        Choice("formatMatcher", "best fit", "basic", "best fit");
        if (civil && (Has("timeZone") || Has("timeZoneName"))) return null;
        var zone = civil ? "UTC" : Has("timeZone") ? icu.DateZone(NumberFormatting.String(Get("timeZone"))) : null;
        if (!civil && Has("timeZone") && zone is null) return null;
        if (Has("calendar"))
        {
            var calendar = NumberFormatting.String(Get("calendar"));
            if (!Regex.IsMatch(calendar, @"\A[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8})*\z", RegexOptions.CultureInvariant)) return null;
            locale = icu.DateCalendar(locale, calendar);
        }
        if (Has("numberingSystem"))
        {
            var system = NumberFormatting.String(Get("numberingSystem"));
            if (!Regex.IsMatch(system, @"\A[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8})*\z", RegexOptions.CultureInvariant)) return null;
            if (icu.HasNumberingSystem(system)) locale = icu.LocaleKeyword(locale, "numbers", system);
        }
        var cycle = Choice("hourCycle", "", "h11", "h12", "h23", "h24");
        char hour = 'j';
        if (Has("hour12"))
        {
            var input = Get("hour12");
            hour = input.Truthy || input.Type.Kind is "object" or "list" ? 'h' : 'H';
        }
        else if (cycle.Length > 0) locale = icu.LocaleKeyword(locale, "hours", cycle);
        var year = Width("year", "numeric", "2-digit");
        var month = Width("month", "numeric", "2-digit", "narrow", "short", "long");
        var day = Width("day", "numeric", "2-digit");
        var weekday = Width("weekday", "narrow", "short", "long");
        var era = Width("era", "narrow", "short", "long");
        var hours = Width("hour", "numeric", "2-digit");
        var minute = Width("minute", "numeric", "2-digit");
        var second = Width("second", "numeric", "2-digit");
        var period = Width("dayPeriod", "narrow", "short", "long");
        var zoneName = Width("timeZoneName", "short", "long", "shortOffset", "longOffset", "shortGeneric", "longGeneric");
        var fraction = 0;
        if (Has("fractionalSecondDigits"))
        {
            var number = NumberFormatting.Number(Get("fractionalSecondDigits"));
            if (!double.IsFinite(number) || number < 1 || number > 3) valid = false;
            else fraction = (int)Math.Floor(number);
        }
        var dateStyle = Choice("dateStyle", "", "full", "long", "medium", "short");
        var timeStyle = Choice("timeStyle", "", "full", "long", "medium", "short");
        var dateFields = year.Length + month.Length + day.Length + weekday.Length + era.Length > 0;
        var timeFields = hours.Length + minute.Length + second.Length + period.Length > 0 || fraction > 0;
        if (format == "date" && (timeFields || timeStyle.Length > 0) || format == "time" && (dateFields || dateStyle.Length > 0)) valid = false;
        if ((dateStyle.Length > 0 || timeStyle.Length > 0) && (dateFields || timeFields || zoneName.Length > 0)) valid = false;
        if (dateStyle.Length == 0 && timeStyle.Length == 0 && !dateFields && !timeFields)
        {
            if (format != "time") dateStyle = "medium";
            if (format != "date") timeStyle = "medium";
            if (zoneName.Length > 0) valid = false;
        }
        static string Numeric(string width, char symbol) => width.Length == 0 ? "" : new(symbol, width == "2-digit" ? 2 : 1);
        static string Named(string width, char symbol) => width.Length == 0 ? "" : new(symbol, width switch { "narrow" => 5, "long" => 4, _ => 3 });
        var skeleton = Numeric(year, 'y') + (month is "numeric" or "2-digit" ? Numeric(month, 'M') : Named(month, 'M'))
            + Numeric(day, 'd') + Named(weekday, 'E') + Named(era, 'G') + Numeric(hours, hour) + Numeric(minute, 'm')
            + Numeric(second, 's') + new string('S', fraction) + Named(period, 'B')
            + (zoneName switch { "short" => "z", "long" => "zzzz", "shortOffset" => "O", "longOffset" => "OOOO", "shortGeneric" => "v", "longGeneric" => "vvvv", _ => "" });
        static int Style(string name) => name switch { "full" => 0, "long" => 1, "medium" => 2, "short" => 3, _ => -1 };
        return valid ? new(locale, zone, skeleton, Style(dateStyle), Style(timeStyle), hour, civil) : null;
    }
}
