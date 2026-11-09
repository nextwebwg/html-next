using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace HtmlNext;

// ICU's public C formatters own locale data and number layout. Each call owns its result and
// formatter handles. The ICU library stays loaded for the process lifetime.
internal sealed partial class IcuFormatters
{
    private static readonly Lazy<IcuFormatters?> Current = new(Load);
    internal static IcuFormatters? Available => Current.Value;
    internal static readonly ValueType PartType = new("object", Fields:
        [new("type", ExpressionValue.StringType), new("value", ExpressionValue.StringType)]);
    internal static readonly ValueType PartsType = new("list", PartType);
    private readonly nint library;
    private readonly string suffix;
    private readonly OpenFormatter open;
    private readonly OpenResult openResult;
    private readonly FormatDouble format;
    private readonly AsValue asValue;
    private readonly Close close;
    private readonly Close closeResult;
    private readonly ValueText text;
    private readonly OpenResult openPosition;
    private readonly Close closePosition;
    private readonly NextPosition nextPosition;
    private readonly Field category;
    private readonly Field field;
    private readonly Indexes indexes;
    private readonly LanguageTag languageTag;
    private readonly CurrencyDigits currencyDigits;

    private IcuFormatters(nint library, string suffix)
    {
        this.library = library; this.suffix = suffix;
        open = Function<OpenFormatter>("unumf_openForSkeletonAndLocale");
        openResult = Function<OpenResult>("unumf_openResult");
        format = Function<FormatDouble>("unumf_formatDouble");
        asValue = Function<AsValue>("unumf_resultAsValue");
        close = Function<Close>("unumf_close");
        closeResult = Function<Close>("unumf_closeResult");
        text = Function<ValueText>("ufmtval_getString");
        openPosition = Function<OpenResult>("ucfpos_open");
        closePosition = Function<Close>("ucfpos_close");
        nextPosition = Function<NextPosition>("ufmtval_nextPosition");
        category = Function<Field>("ucfpos_getCategory");
        field = Function<Field>("ucfpos_getField");
        indexes = Function<Indexes>("ucfpos_getIndexes");
        languageTag = Function<LanguageTag>("uloc_forLanguageTag");
        currencyDigits = Function<CurrencyDigits>("ucurr_getDefaultFractionDigits");
    }

    private T Function<T>(string name) where T : Delegate =>
        Marshal.GetDelegateForFunctionPointer<T>(NativeLibrary.GetExport(library, name + suffix));

    private static IcuFormatters? Load()
    {
        foreach (var (file, suffix) in Libraries())
        {
            if (!NativeLibrary.TryLoad(file, out var library)) continue;
            try { return new(library, suffix); }
            catch (EntryPointNotFoundException) { NativeLibrary.Free(library); }
        }
        return null;
    }

    private static IEnumerable<(string File, string Suffix)> Libraries()
    {
        if (OperatingSystem.IsMacOS()) { yield return ("/usr/lib/libicucore.A.dylib", ""); yield break; }
        if (OperatingSystem.IsWindows()) { yield return ("icu.dll", ""); yield break; }
        var roots = new[] { AppContext.BaseDirectory, "/usr/lib", "/lib", "/usr/lib64", "/lib64", "/usr/local/lib" };
        var directories = roots.Where(Directory.Exists).SelectMany(root =>
            new[] { root }.Concat(Directory.EnumerateDirectories(root, "*-linux-*"))).Distinct(StringComparer.Ordinal);
        var files = directories.SelectMany(directory => Directory.EnumerateFiles(directory, "libicui18n.so.*"))
            .Select(file => (File: file, Major: Regex.Match(Path.GetFileName(file), @"\.so\.(\d+)").Groups[1].Value))
            .Where(entry => entry.Major.Length > 0).OrderByDescending(entry => int.Parse(entry.Major, CultureInfo.InvariantCulture));
        foreach (var entry in files) yield return (entry.File, "_" + entry.Major);
        yield return ("libicui18n.so", "");
    }

    internal bool Locale(string tag, out string locale, bool overrideNumbering = false)
    {
        locale = "";
        // Intl accepts Unicode locale identifiers, a narrower grammar than ICU's BCP 47 parser.
        var syntax = Regex.Match(tag, @"^(?:[a-z]{2,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?<variant>[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-(?<extension>[0-9a-wy-z])(?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (!syntax.Success) return false;
        foreach (var group in new[] { "variant", "extension" })
        {
            var entries = syntax.Groups[group].Captures.Select(capture => capture.Value).ToArray();
            if (entries.Distinct(StringComparer.OrdinalIgnoreCase).Count() != entries.Length) return false;
        }
        var subtags = tag.Split('-');
        var unicode = Array.FindIndex(subtags, subtag => subtag.Equals("u", StringComparison.OrdinalIgnoreCase));
        var privateUse = Array.FindIndex(subtags, subtag => subtag.Equals("x", StringComparison.OrdinalIgnoreCase));
        if (unicode >= 0 && (privateUse < 0 || unicode < privateUse))
            for (var index = unicode + 1; index < subtags.Length && subtags[index].Length > 1; index++)
                if (subtags[index].Length == 2 && !char.IsAsciiLetter(subtags[index][1])) return false;
        var status = 0;
        var length = languageTag(tag, 0, 0, out var parsed, ref status);
        if (parsed != tag.Length || status is not (0 or 15) && status > 0) return false;
        var buffer = Marshal.AllocHGlobal(length + 1);
        try
        {
            status = 0;
            languageTag(tag, buffer, length + 1, out parsed, ref status);
            if (status > 0 || parsed != tag.Length) return false;
            locale = Marshal.PtrToStringUTF8(buffer)!;
            var keyword = Function<KeywordValue>("uloc_getKeywordValue");
            var keywordLength = keyword(locale, "numbers", 0, 0, ref status);
            if (keywordLength > 0)
            {
                var numbers = Marshal.AllocHGlobal(keywordLength + 1);
                try
                {
                    status = 0;
                    keyword(locale, "numbers", numbers, keywordLength + 1, ref status);
                    if (status > 0) return false;
                    if (overrideNumbering || !HasNumberingSystem(Marshal.PtrToStringUTF8(numbers)!))
                    {
                        var clear = Function<SetKeyword>("uloc_setKeywordValue");
                        clear("numbers", null, buffer, length + 1, ref status);
                        if (status > 0) return false;
                        locale = Marshal.PtrToStringUTF8(buffer)!;
                    }
                }
                finally { Marshal.FreeHGlobal(numbers); }
            }
            return true;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal bool HasNumberingSystem(string name)
    {
        var status = 0;
        var open = Function<OpenNumbering>("unumsys_openByName");
        var close = Function<Close>("unumsys_close");
        var system = open(name, ref status);
        try { return status <= 0 && system != 0; }
        finally { if (system != 0) close(system); }
    }

    internal int CurrencyPrecision(string currency)
    {
        var status = 0;
        var digits = currencyDigits(currency, ref status);
        return status > 0 ? 2 : digits;
    }

    internal bool Format(string skeleton, string? locale, double number, double? end, bool parts, out ExpressionValue output)
    {
        output = ExpressionValue.Invalid;
        if (end is not null) return Range(skeleton, locale, number, end.Value, out output);
        var status = 0;
        var formatter = open(skeleton, skeleton.Length, locale, ref status);
        nint result = 0;
        try
        {
            if (status > 0 || formatter == 0) return false;
            result = openResult(ref status);
            if (status > 0 || result == 0) return false;
            format(formatter, number, result, ref status);
            if (status > 0) return false;
            var value = asValue(result, ref status);
            if (status > 0 || value == 0) return false;
            var pointer = text(value, out var length, ref status);
            if (status > 0 || pointer == 0) return false;
            var written = Marshal.PtrToStringUni(pointer, length)!;
            output = parts ? Parts(value, number, written, skeleton.Contains("measure-unit/", StringComparison.Ordinal), ref status) : ExpressionValue.Text(written);
            return status <= 0;
        }
        finally { if (result != 0) closeResult(result); if (formatter != 0) close(formatter); }
    }

    private ExpressionValue Parts(nint value, double number, string written, bool unit, ref int status)
    {
        var position = openPosition(ref status);
        if (status > 0 || position == 0) { if (position != 0) closePosition(position); return ExpressionValue.Invalid; }
        var regions = new List<(int Field, int Start, int End)>();
        try
        {
            while (nextPosition(value, position, ref status) != 0)
            {
                if (category(position, ref status) != 2) continue;
                indexes(position, out var start, out var end, ref status);
                regions.Add((field(position, ref status), start, end));
            }
        }
        finally { closePosition(position); }
        if (status > 0) return ExpressionValue.Invalid;
        return StructuredParts(written, regions, field => field switch
        {
            0 => "integer", 1 => "fraction", 2 => "decimal", 3 => "exponentSeparator", 4 => "exponentMinusSign",
            5 => "exponentInteger", 6 => "group", 7 => "currency", 8 => unit ? "unit" : "percentSign",
            10 => double.IsNegative(number) ? "minusSign" : "plusSign", 11 => "unit", 12 => "compact", 13 => "approximatelySign", _ => "literal"
        });
    }

    private static ExpressionValue StructuredParts(string written, IEnumerable<(int Field, int Start, int End)> fields, Func<int, string> fieldType)
    {
        var regions = fields.ToArray();
        var boundaries = regions.SelectMany(region => new[] { region.Start, region.End }).Append(0).Append(written.Length).Distinct().Order().ToArray();
        var parts = new List<(string Type, string Text)>();
        for (var index = 0; index + 1 < boundaries.Length; index++)
        {
            var start = boundaries[index]; var end = boundaries[index + 1];
            var covering = regions.Where(region => region.Start <= start && region.End >= end)
                .OrderBy(region => region.End - region.Start).ThenByDescending(region => region.Field).ToArray();
            var type = covering.Length == 0 ? "literal" : fieldType(covering[0].Field);
            var part = written[start..end];
            if (parts.Count > 0 && parts[^1].Type == type) parts[^1] = (type, parts[^1].Text + part);
            else parts.Add((type, part));
        }
        return new(PartsType, parts.Select(part => new ExpressionValue(PartType,
            new[] { ExpressionValue.Text(part.Type), ExpressionValue.Text(part.Text) })).ToArray());
    }

    private bool Range(string skeleton, string? locale, double first, double last, out ExpressionValue output)
    {
        output = ExpressionValue.Invalid;
        if (!NativeLibrary.TryGetExport(library, "unumrf_openForSkeletonWithCollapseAndIdentityFallback" + suffix, out var address)) return false;
        var rangeOpen = Marshal.GetDelegateForFunctionPointer<OpenRange>(address);
        var rangeResult = Function<OpenResult>("unumrf_openResult");
        var rangeFormat = Function<FormatRange>("unumrf_formatDoubleRange");
        var rangeValue = Function<AsValue>("unumrf_resultAsValue");
        var rangeClose = Function<Close>("unumrf_close");
        var resultClose = Function<Close>("unumrf_closeResult");
        var status = 0;
        var formatter = rangeOpen(skeleton, skeleton.Length, 0, 2, locale, 0, ref status);
        nint result = 0;
        try
        {
            if (status > 0 || formatter == 0) return false;
            result = rangeResult(ref status);
            if (status > 0 || result == 0) return false;
            rangeFormat(formatter, first, last, result, ref status);
            if (status > 0) return false;
            var value = rangeValue(result, ref status);
            if (status > 0 || value == 0) return false;
            var pointer = text(value, out var length, ref status);
            if (status > 0 || pointer == 0) return false;
            output = ExpressionValue.Text(Marshal.PtrToStringUni(pointer, length)!);
            return true;
        }
        finally { if (result != 0) resultClose(result); if (formatter != 0) rangeClose(formatter); }
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int KeywordValue([MarshalAs(UnmanagedType.LPUTF8Str)] string locale, [MarshalAs(UnmanagedType.LPUTF8Str)] string keyword, nint buffer, int capacity, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int SetKeyword([MarshalAs(UnmanagedType.LPUTF8Str)] string keyword, [MarshalAs(UnmanagedType.LPUTF8Str)] string? value, nint buffer, int capacity, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint OpenNumbering([MarshalAs(UnmanagedType.LPUTF8Str)] string name, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint OpenFormatter([MarshalAs(UnmanagedType.LPWStr)] string skeleton, int length, [MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint OpenResult(ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void FormatDouble(nint formatter, double value, nint result, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint AsValue(nint result, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void Close(nint value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint ValueText(nint value, out int length, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate byte NextPosition(nint value, nint position, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int Field(nint position, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void Indexes(nint position, out int start, out int end, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int LanguageTag([MarshalAs(UnmanagedType.LPUTF8Str)] string tag, nint locale, int capacity, out int parsedLength, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int CurrencyDigits([MarshalAs(UnmanagedType.LPWStr)] string currency, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint OpenRange([MarshalAs(UnmanagedType.LPWStr)] string skeleton, int length, int collapse, int identity, [MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, nint parseError, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void FormatRange(nint formatter, double first, double last, nint result, ref int status);
}
