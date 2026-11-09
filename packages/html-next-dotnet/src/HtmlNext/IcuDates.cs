using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace HtmlNext;

internal sealed partial class IcuFormatters
{
    internal string LocaleKeyword(string? locale, string key, string? value)
    {
        locale ??= Marshal.PtrToStringUTF8(Function<DefaultLocale>("uloc_getDefault")())!;
        var bytes = Encoding.UTF8.GetBytes(locale + '\0');
        var capacity = checked(bytes.Length + key.Length + Encoding.UTF8.GetByteCount(value ?? "") + 4);
        var buffer = Marshal.AllocHGlobal(capacity);
        try
        {
            Marshal.Copy(bytes, 0, buffer, bytes.Length);
            var status = 0;
            Function<SetKeyword>("uloc_setKeywordValue")(key, value, buffer, capacity, ref status);
            return status <= 0 ? Marshal.PtrToStringUTF8(buffer)! : locale;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    internal string? DateCalendar(string? locale, string calendar)
    {
        var legacy = Function<LegacyType>("uloc_toLegacyType")("calendar", calendar);
        var name = legacy == 0 ? calendar : Marshal.PtrToStringUTF8(legacy)!;
        var status = 0;
        var enumeration = Function<CalendarValues>("ucal_getKeywordValuesForLocale")("calendar", locale, 0, ref status);
        if (status > 0 || enumeration == 0) { if (enumeration != 0) Function<Close>("uenum_close")(enumeration); return LocaleKeyword(locale, "calendar", null); }
        try
        {
            var next = Function<EnumerationNext>("uenum_next");
            while (status <= 0)
            {
                var pointer = next(enumeration, out var length, ref status);
                if (pointer == 0) break;
                if (Marshal.PtrToStringUTF8(pointer, length) == name) return LocaleKeyword(locale, "calendar", name);
            }
            return LocaleKeyword(locale, "calendar", null);
        }
        finally { Function<Close>("uenum_close")(enumeration); }
    }
    internal string? DateZone(string input)
    {
        var offset = Regex.Match(input, @"\A([+-])([0-9]{2})(?::?([0-9]{2}))?\z", RegexOptions.CultureInvariant);
        if (offset.Success)
        {
            var hours = int.Parse(offset.Groups[2].Value, CultureInfo.InvariantCulture);
            var minutes = offset.Groups[3].Length == 0 ? 0 : int.Parse(offset.Groups[3].Value, CultureInfo.InvariantCulture);
            return hours < 24 && minutes < 60 ? "GMT" + offset.Groups[1].Value + hours.ToString("00", CultureInfo.InvariantCulture) + ":" + minutes.ToString("00", CultureInfo.InvariantCulture) : null;
        }
        if (input.Equals("UTC", StringComparison.OrdinalIgnoreCase) || input.Equals("GMT", StringComparison.OrdinalIgnoreCase)) return "UTC";
        var canonical = Function<CanonicalZone>("ucal_getCanonicalTimeZoneID");
        string? Canonical(string name)
        {
            byte system = 0;
            var result = ReadText((nint buffer, int capacity, ref int status) => canonical(name, name.Length, buffer, capacity, out system, ref status));
            return system != 0 ? result : null;
        }
        var direct = Canonical(input);
        if (direct is not null) return direct;
        var error = 0;
        var enumeration = Function<OpenResult>("ucal_openTimeZones")(ref error);
        try
        {
            if (error > 0 || enumeration == 0) return null;
            var next = Function<EnumerationNext>("uenum_next");
            while (error <= 0)
            {
                var pointer = next(enumeration, out var length, ref error);
                if (pointer == 0) return null;
                var name = Marshal.PtrToStringUTF8(pointer, length)!;
                if (name.Equals(input, StringComparison.OrdinalIgnoreCase)) return Canonical(name);
            }
            return null;
        }
        finally { if (enumeration != 0) Function<Close>("uenum_close")(enumeration); }
    }

    internal bool FormatDate(DateSettings settings, double first, double? last, bool parts, out ExpressionValue output)
    {
        output = ExpressionValue.Invalid;
        var dateOpen = Function<DateOpen>("udat_open");
        var dateClose = Function<Close>("udat_close");
        var status = 0;
        nint formatter = 0;
        nint generator = 0;
        try
        {
            var skeleton = settings.Skeleton;
            var styled = settings.DateStyle >= 0 || settings.TimeStyle >= 0;
            formatter = dateOpen(styled ? settings.TimeStyle : -2, styled ? settings.DateStyle : -2, settings.Locale,
                settings.Zone, settings.Zone?.Length ?? 0, styled ? null : "y", styled ? 0 : 1, ref status);
            if (status > 0 || formatter == 0) return false;
            generator = Function<OpenLocale>("udatpg_open")(settings.Locale, ref status);
            if (status > 0 || generator == 0) return false;
            var toPattern = Function<DatePattern>("udat_toPattern");
            var getSkeleton = Function<PatternText>("udatpg_getSkeleton");
            if (styled)
            {
                var pattern = ReadText((nint buffer, int capacity, ref int error) => toPattern(formatter, 0, buffer, capacity, ref error));
                if (pattern is null) return false;
                skeleton = ReadText((nint buffer, int capacity, ref int error) => getSkeleton(0, pattern, pattern.Length, buffer, capacity, ref error))!;
                if (skeleton is null) return false;
                if (settings.Hour != 'j') skeleton = Regex.Replace(skeleton, "[hHKkj]", settings.Hour.ToString());
            }
            if (!styled || settings.Hour != 'j')
            {
                var best = Function<BestPattern>("udatpg_getBestPatternWithOptions");
                var pattern = ReadText((nint buffer, int capacity, ref int error) => best(generator, skeleton, skeleton.Length, 1 << 11, buffer, capacity, ref error));
                if (pattern is null) return false;
                Function<ApplyPattern>("udat_applyPattern")(formatter, 0, pattern, pattern.Length);
            }
            var calendar = Function<CalendarForDate>("udat_getCalendar")(formatter);
            if (calendar == 0) return false;
            var clone = Function<AsValue>("ucal_clone")(calendar, ref status);
            try
            {
                if (status > 0 || clone == 0) return false;
                var type = Function<AsValue>("ucal_getType")(clone, ref status);
                if (status > 0 || type == 0) return false;
                if (Marshal.PtrToStringUTF8(type) == "gregorian")
                {
                    Function<CalendarCutover>("ucal_setGregorianChange")(clone, -8.64e15, ref status);
                    if (status > 0) return false;
                    Function<DateCalendarSet>("udat_setCalendar")(formatter, clone);
                }
            }
            finally { if (clone != 0) Function<Close>("ucal_close")(clone); }
            if (last is not null)
            {
                if (!DateRange(settings, skeleton, Function<CalendarForDate>("udat_getCalendar")(formatter), first, last.Value, out output, out var collapsed)) return false;
                if (!collapsed) return true;
            }
            var dateFormat = Function<DateFormat>("udat_formatForFields");
            var positions = parts || settings.Civil;
            var position = positions ? Function<OpenResult>("ufieldpositer_open")(ref status) : 0;
            try
            {
                if (status > 0 || positions && position == 0) return false;
                var written = ReadText((nint buffer, int capacity, ref int error) => dateFormat(formatter, first, buffer, capacity, position, ref error));
                if (written is null) return false;
                if (!positions)
                {
                    // Browser Intl keeps its established spaces for complete date text; parts retain ICU's original fields.
                    output = ExpressionValue.Text(written.Replace('\u202f', ' ').Replace('\u2009', ' '));
                    return true;
                }
                var regions = new List<(int Field, int Start, int End)>();
                var next = Function<DatePosition>("ufieldpositer_next");
                int field;
                while ((field = next(position, out var start, out var end)) >= 0) regions.Add((field, start, end));
                output = DateOutput(StructuredParts(written, regions, DateField), written, parts, settings.Civil);
                return true;
            }
            finally { if (position != 0) Function<Close>("ufieldpositer_close")(position); }
        }
        finally
        {
            if (generator != 0) Function<Close>("udatpg_close")(generator);
            if (formatter != 0) dateClose(formatter);
        }
    }

    private bool DateRange(DateSettings settings, string skeleton, nint calendar, double first, double last, out ExpressionValue output, out bool collapsed)
    {
        output = ExpressionValue.Invalid;
        collapsed = false;
        var status = 0;
        var open = Function<DateRangeOpen>("udtitvfmt_open");
        var formatter = open(settings.Locale, skeleton, skeleton.Length, settings.Zone, settings.Zone?.Length ?? 0, ref status);
        nint result = 0;
        try
        {
            if (status > 0 || formatter == 0) return false;
            result = Function<OpenResult>("udtitvfmt_openResult")(ref status);
            if (status > 0 || result == 0) return false;
            var from = Function<AsValue>("ucal_clone")(calendar, ref status);
            nint to = 0;
            try
            {
                if (status > 0 || from == 0) return false;
                to = Function<AsValue>("ucal_clone")(calendar, ref status);
                if (status > 0 || to == 0) return false;
                var set = Function<CalendarCutover>("ucal_setMillis");
                set(from, first, ref status);
                set(to, last, ref status);
                if (status > 0) return false;
                Function<DateCalendarRange>("udtitvfmt_formatCalendarToResult")(formatter, from, to, result, ref status);
            }
            finally { if (from != 0) Function<Close>("ucal_close")(from); if (to != 0) Function<Close>("ucal_close")(to); }
            if (status > 0) return false;
            var value = Function<AsValue>("udtitvfmt_resultAsValue")(result, ref status);
            if (status > 0 || value == 0) return false;
            var regions = new List<(int Field, int Start, int End)>();
            var position = openPosition(ref status);
            try
            {
                if (status > 0 || position == 0) return false;
                collapsed = true;
                while (nextPosition(value, position, ref status) != 0)
                {
                    var group = category(position, ref status);
                    if (group == 0x1000 + 5) collapsed = false; // UFIELD_CATEGORY_DATE_INTERVAL_SPAN
                    if (group != 1) continue; // UFIELD_CATEGORY_DATE
                    indexes(position, out var start, out var end, ref status);
                    regions.Add((field(position, ref status), start, end));
                }
                if (status > 0) return false;
            }
            finally { if (position != 0) closePosition(position); }
            var pointer = text(value, out var length, ref status);
            if (status > 0 || pointer == 0) return false;
            var written = Marshal.PtrToStringUni(pointer, length)!;
            output = settings.Civil ? DateOutput(StructuredParts(written, regions, DateField), written, false, true, range: true) : ExpressionValue.Text(written);
            return true;
        }
        finally { if (result != 0) Function<Close>("udtitvfmt_closeResult")(result); if (formatter != 0) Function<Close>("udtitvfmt_close")(formatter); }
    }
    private static string DateField(int field) => field switch
    {
        0 => "era", 1 or 18 or 20 => "year", 2 or 26 => "month", 3 => "day", 4 or 5 or 15 or 16 => "hour",
        6 => "minute", 7 => "second", 8 => "fractionalSecond", 9 or 19 or 25 => "weekday", 14 or 35 or 36 => "dayPeriod",
        17 or 23 or 24 or 29 or 31 or 32 or 33 => "timeZoneName", 30 => "yearName", 34 => "relatedYear", _ => "literal"
    };
    private static ExpressionValue DateOutput(ExpressionValue parts, string written, bool structured, bool civil, bool range = false)
    {
        var entries = (ExpressionValue[])parts.Data!;
        static string Type(ExpressionValue part) => part.Member("type").ScalarText();
        static string Text(ExpressionValue part) => part.Member("value").ScalarText();
        var hasZone = civil && entries.Any(part => Type(part) == "timeZoneName");
        if (!structured && !hasZone) return ExpressionValue.Text(range ? written : written.Replace('\u202f', ' ').Replace('\u2009', ' '));
        if (hasZone) entries = entries.Where((part, index) => Type(part) != "timeZoneName" && !(Type(part) == "literal"
            && Regex.IsMatch(Text(part), @"\A[\s(),]*\z", RegexOptions.CultureInvariant)
            && (index > 0 && Type(entries[index - 1]) == "timeZoneName" || index + 1 < entries.Length && Type(entries[index + 1]) == "timeZoneName"))).ToArray();
        return structured ? new(PartsType, entries) : ExpressionValue.Text(string.Concat(entries.Select(Text)));
    }
    private delegate int OutputBuffer(nint buffer, int capacity, ref int status);
    private static string? ReadText(OutputBuffer write)
    {
        var status = 0;
        var probe = Marshal.AllocHGlobal(2);
        int length;
        try { length = write(probe, 1, ref status); }
        finally { Marshal.FreeHGlobal(probe); }
        if (length < 0 || status > 0 && status != 15) return null;
        var buffer = Marshal.AllocHGlobal(checked((length + 1) * 2));
        try
        {
            status = 0;
            var actual = write(buffer, length + 1, ref status);
            return status <= 0 && actual >= 0 && actual <= length ? Marshal.PtrToStringUni(buffer, actual) : null;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint DefaultLocale();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint LegacyType([MarshalAs(UnmanagedType.LPUTF8Str)] string key, [MarshalAs(UnmanagedType.LPUTF8Str)] string type);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint CalendarValues([MarshalAs(UnmanagedType.LPUTF8Str)] string key, [MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, byte commonlyUsed, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint EnumerationNext(nint enumeration, out int length, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int CanonicalZone([MarshalAs(UnmanagedType.LPWStr)] string zone, int length, nint result, int capacity, out byte system, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint DateOpen(int timeStyle, int dateStyle, [MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, [MarshalAs(UnmanagedType.LPWStr)] string? zone, int zoneLength, [MarshalAs(UnmanagedType.LPWStr)] string? pattern, int patternLength, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint OpenLocale([MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int DatePattern(nint formatter, byte localized, nint result, int capacity, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int PatternText(nint generator, [MarshalAs(UnmanagedType.LPWStr)] string pattern, int length, nint result, int capacity, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int BestPattern(nint generator, [MarshalAs(UnmanagedType.LPWStr)] string skeleton, int length, int options, nint result, int capacity, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void ApplyPattern(nint formatter, byte localized, [MarshalAs(UnmanagedType.LPWStr)] string pattern, int length);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint CalendarForDate(nint formatter);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void CalendarCutover(nint calendar, double change, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void DateCalendarSet(nint formatter, nint calendar);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int DateFormat(nint formatter, double date, nint result, int capacity, nint positions, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int DatePosition(nint positions, out int start, out int end);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void DateCalendarRange(nint formatter, nint from, nint to, nint result, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint DateRangeOpen([MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, [MarshalAs(UnmanagedType.LPWStr)] string skeleton, int skeletonLength, [MarshalAs(UnmanagedType.LPWStr)] string? zone, int zoneLength, ref int status);
}
