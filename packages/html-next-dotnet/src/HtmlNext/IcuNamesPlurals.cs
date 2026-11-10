using System.Runtime.InteropServices;

namespace HtmlNext;

internal sealed partial class IcuFormatters
{
    internal bool LanguageDisplayCode(string tag, out string locale)
    {
        if (!Locale(tag, out locale)) return false;
        var toTag = Function<LocaleToTag>("uloc_toLanguageTag");
        var status = 0;
        var probe = Marshal.AllocHGlobal(1);
        int length;
        try { length = toTag(locale, probe, 1, 1, ref status); }
        finally { Marshal.FreeHGlobal(probe); }
        if (length < 0 || status > 0 && status != 15) return false;
        var buffer = Marshal.AllocHGlobal(length + 1);
        try
        {
            status = 0;
            toTag(locale, buffer, length + 1, 1, ref status);
            if (status > 0) return false;
            var parts = Marshal.PtrToStringUTF8(buffer)!.Split('-').ToList();
            // Public C tag conversion handles IANA aliases; these CLDR aliases are additional.
            // Preserve authored scripts instead of replacing them with an alias's default.
            if (parts[0] is "sh" or "hbs")
            {
                parts[0] = "sr";
                if (parts.Count < 2 || parts[1].Length != 4) parts.Insert(1, "Latn");
            }
            else if (parts[0] is "tl" or "tgl") parts[0] = "fil";
            for (var index = 1; index < parts.Count; index++) if (parts[index] == "Qaai") parts[index] = "Zinh";
            return Locale(string.Join('-', parts), out locale);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal bool PluralCategory(string? locale, bool ordinal, string skeleton, double number, out string category)
    {
        category = "";
        var status = 0;
        var rules = Function<PluralOpen>("uplrules_openForType")(locale, ordinal ? 1 : 0, ref status);
        nint formatter = 0;
        nint result = 0;
        try
        {
            if (status > 0 || rules == 0) return false;
            formatter = open(skeleton, skeleton.Length, locale, ref status);
            if (status > 0 || formatter == 0) return false;
            result = openResult(ref status);
            if (status > 0 || result == 0) return false;
            format(formatter, number, result, ref status);
            if (status > 0) return false;
            var select = Function<PluralSelect>("uplrules_selectFormatted");
            var selected = ReadText((nint buffer, int capacity, ref int error) => select(rules, result, buffer, capacity, ref error));
            if (selected is null) return false;
            category = selected;
            return true;
        }
        finally
        {
            if (result != 0) closeResult(result);
            if (formatter != 0) close(formatter);
            if (rules != 0) Function<Close>("uplrules_close")(rules);
        }
    }
    internal bool DisplayName(string? locale, string type, string style, bool dialect, bool noSubstitute, string code, out string? output)
    {
        output = null;
        var status = 0;
        if (type == "currency")
        {
            var pointer = Function<CurrencyName>("ucurr_getName")(code, locale, 1, out _, out var length, ref status);
            if (status > 0 || pointer == 0) return false;
            var name = Marshal.PtrToStringUni(pointer, length)!;
            output = name == code ? null : name;
            return true;
        }
        if (type == "dateTimeField")
        {
            var field = code switch { "era" => 0, "year" => 1, "quarter" => 2, "month" => 3, "weekOfYear" => 4, "weekday" => 6,
                "day" => 9, "dayPeriod" => 10, "hour" => 11, "minute" => 12, "second" => 13, "timeZoneName" => 15, _ => -1 };
            if (field < 0) return false;
            var generator = Function<OpenLocale>("udatpg_open")(locale, ref status);
            try
            {
                if (status > 0 || generator == 0) return false;
                var get = Function<FieldName>("udatpg_getFieldDisplayName");
                output = ReadText((nint buffer, int capacity, ref int error) => get(generator, field, style switch { "long" => 0, "short" => 1, _ => 2 }, buffer, capacity, ref error));
                return output is not null;
            }
            finally { if (generator != 0) Function<Close>("udatpg_close")(generator); }
        }
        var contexts = new[] { dialect ? 1 : 0, style == "long" ? 0x200 : 0x201, noSubstitute ? 0x301 : 0x300 };
        var names = Function<NamesOpen>("uldn_openForContext")(locale, contexts, contexts.Length, ref status);
        try
        {
            if (status > 0 || names == 0) return false;
            string? value;
            if (type == "calendar")
            {
                // DisplayNames preserves aliases as codes; only map the standardized ICU resource names.
                var legacy = code switch { "gregory" => "gregorian", "ethioaa" => "ethiopic-amete-alem", _ => code };
                var get = Function<KeyName>("uldn_keyValueDisplayName");
                value = ReadDisplayName((nint buffer, int capacity, ref int error) => get(names, "calendar", legacy, buffer, capacity, ref error));
            }
            else
            {
                var get = Function<CodeName>(type switch { "language" => "uldn_localeDisplayName", "script" => "uldn_scriptDisplayName", _ => "uldn_regionDisplayName" });
                value = ReadDisplayName((nint buffer, int capacity, ref int error) => get(names, code, buffer, capacity, ref error));
            }
            if (value is null) return false;
            output = value.Length == 0 ? null : value;
            return true;
        }
        finally { if (names != 0) Function<Close>("uldn_close")(names); }
    }

    private static string? ReadDisplayName(OutputBuffer read) => ReadText((nint buffer, int capacity, ref int status) =>
    {
        var length = read(buffer, capacity, ref status);
        // ICU represents an unavailable name under NO_SUBSTITUTE as a bogus empty string.
        // Code syntax and constructor options have already been checked by the adapter.
        if (length == 0 && status == 1) status = 0;
        return length;
    });

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int LocaleToTag([MarshalAs(UnmanagedType.LPUTF8Str)] string locale, nint result, int capacity, byte strict, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint PluralOpen([MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, int type, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int PluralSelect(nint rules, nint number, nint result, int capacity, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint CurrencyName([MarshalAs(UnmanagedType.LPWStr)] string currency, [MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, int style, out byte choice, out int length, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int FieldName(nint generator, int field, int width, nint result, int capacity, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint NamesOpen([MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, [In] int[] contexts, int count, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int CodeName(nint names, [MarshalAs(UnmanagedType.LPUTF8Str)] string code, nint result, int capacity, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int KeyName(nint names, [MarshalAs(UnmanagedType.LPUTF8Str)] string key, [MarshalAs(UnmanagedType.LPUTF8Str)] string value, nint result, int capacity, ref int status);
}
