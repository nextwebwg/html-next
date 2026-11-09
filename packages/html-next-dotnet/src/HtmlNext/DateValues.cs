using System.Globalization;
using System.Text.RegularExpressions;

namespace HtmlNext;

internal static class DateValues
{
    internal static bool IsType(string kind) => kind is "date" or "time" or "datetime-local" or "datetime";
    private static readonly Regex Date = new(@"\A([0-9]{4,})-([0-9]{2})-([0-9]{2})\z", RegexOptions.CultureInvariant);
    private static readonly Regex Clock = new(@"\A([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?\z", RegexOptions.CultureInvariant);
    private static readonly Regex DateTime = new(@"\A([0-9]{4,}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,3})?)?)(Z|[+-][0-9]{2}:[0-9]{2})?\z", RegexOptions.CultureInvariant);
    internal static bool Valid(string kind, string text) => kind switch
    {
        "date" => Day(text, out _), "time" => Time(text, out _),
        "datetime-local" => DateTime.Match(text) is { Success: true } match && match.Groups[3].Length == 0 && Instant(text, "dateTime", out _),
        "datetime" => DateTime.Match(text) is { Success: true } match && text.Contains('T') && match.Groups[3].Length > 0 && Instant(text, "dateTime", out _),
        _ => false
    };
    internal static bool Civil(string? kind, ExpressionValue value) => kind is "date" or "time" or "datetime-local"
        || value.IsText && !Regex.IsMatch(value.ScalarText(), @"(?:Z|[+-][0-9]{2}:[0-9]{2})\z", RegexOptions.CultureInvariant);
    internal static bool Epoch(ExpressionValue value, string format, out double epoch)
    {
        epoch = Math.Truncate(value.Number);
        return value.IsNumeric ? double.IsFinite(epoch) && Math.Abs(epoch) <= 8.64e15 : value.IsText && Instant(value.ScalarText(), format, out epoch);
    }
    private static bool Instant(string text, string format, out double epoch)
    {
        epoch = 0;
        if (Clock.IsMatch(text)) return format == "time" && Time(text, out epoch);
        if (Date.IsMatch(text)) return format == "date" && Day(text, out epoch);
        var match = DateTime.Match(text);
        if (!match.Success || !Day(match.Groups[1].Value, out var day) || !Time(match.Groups[2].Value, out var time)) return false;
        var zone = match.Groups[3].Value;
        var offset = 0;
        if (zone.Length > 1)
        {
            var hours = int.Parse(zone.AsSpan(1, 2), CultureInfo.InvariantCulture);
            var minutes = int.Parse(zone.AsSpan(4, 2), CultureInfo.InvariantCulture);
            if (hours > 23 || minutes > 59) return false;
            offset = (hours * 60 + minutes) * (zone[0] == '-' ? -1 : 1);
        }
        epoch = day + time - offset * 60000d;
        return Math.Abs(epoch) <= 8.64e15;
    }
    private static bool Time(string text, out double milliseconds)
    {
        milliseconds = 0;
        var match = Clock.Match(text);
        if (!match.Success) return false;
        int Read(int index) => match.Groups[index].Length == 0 ? 0 : int.Parse(match.Groups[index].Value, CultureInfo.InvariantCulture);
        var hours = Read(1); var minutes = Read(2); var seconds = Read(3);
        if (hours > 23 || minutes > 59 || seconds > 59) return false;
        var fraction = match.Groups[4].Value.PadRight(3, '0');
        milliseconds = ((hours * 60d + minutes) * 60 + seconds) * 1000 + int.Parse(fraction, CultureInfo.InvariantCulture);
        return true;
    }
    private static bool Day(string text, out double milliseconds)
    {
        milliseconds = 0;
        var match = Date.Match(text);
        if (!match.Success || !int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var year) || year is < 1 or > 275760) return false;
        var month = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
        var day = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
        if (month is < 1 or > 12 || day < 1) return false;
        var leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        var maximum = month == 2 ? leap ? 29 : 28 : month is 4 or 6 or 9 or 11 ? 30 : 31;
        if (day > maximum) return false;
        // DateTime's calendar stops at year 9999. The proposal accepts extended HTML years.
        // Convert the same proleptic Gregorian civil day to the Unix epoch over that wider range.
        var y = year - (month <= 2 ? 1 : 0);
        var era = y / 400;
        var inEra = y - era * 400;
        var dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
        var days = era * 146097L + inEra * 365 + inEra / 4 - inEra / 100 + dayOfYear - 719468;
        milliseconds = days * 86400000d;
        return Math.Abs(milliseconds) <= 8.64e15;
    }
}
