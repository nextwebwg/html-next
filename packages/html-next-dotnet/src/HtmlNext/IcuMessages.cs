using System.Runtime.InteropServices;

namespace HtmlNext;

internal sealed partial class IcuFormatters
{
    internal bool FormatList(string? locale, int type, int width, string[] items, bool parts, out ExpressionValue output)
    {
        output = ExpressionValue.Invalid;
        var strings = new nint[items.Length];
        var status = 0;
        var formatter = Function<ListOpen>("ulistfmt_openForType")(locale, type, width, ref status);
        nint result = 0;
        try
        {
            if (status > 0 || formatter == 0) return false;
            result = Function<OpenResult>("ulistfmt_openResult")(ref status);
            if (status > 0 || result == 0) return false;
            var lengths = new int[items.Length];
            for (var index = 0; index < items.Length; index++) { strings[index] = Marshal.StringToHGlobalUni(items[index]); lengths[index] = items[index].Length; }
            Function<ListFormat>("ulistfmt_formatStringsToResult")(formatter, strings, lengths, strings.Length, result, ref status);
            if (status > 0) return false;
            var value = Function<AsValue>("ulistfmt_resultAsValue")(result, ref status);
            if (status > 0 || value == 0) return false;
            var pointer = text(value, out var length, ref status);
            if (status > 0 || pointer == 0) return false;
            var written = Marshal.PtrToStringUni(pointer, length)!;
            if (!parts) { output = ExpressionValue.Text(written); return true; }
            var regions = new List<(int Field, int Start, int End)>();
            var position = openPosition(ref status);
            try
            {
                if (status > 0 || position == 0) return false;
                while (nextPosition(value, position, ref status) != 0)
                {
                    if (category(position, ref status) != 3 || field(position, ref status) != 1) continue;
                    indexes(position, out var start, out var end, ref status);
                    regions.Add((1, start, end));
                }
            }
            finally { if (position != 0) closePosition(position); }
            if (status > 0) return false;
            // Adjacent elements remain separate even when a locale uses no separator.
            var entries = new List<ExpressionValue>();
            var cursor = 0;
            void Part(string type, string value) => entries.Add(new(PartType, new[] { ExpressionValue.Text(type), ExpressionValue.Text(value) }));
            foreach (var region in regions.OrderBy(region => region.Start))
            {
                if (region.Start > cursor) Part("literal", written[cursor..region.Start]);
                Part("element", written[region.Start..region.End]);
                cursor = region.End;
            }
            if (cursor < written.Length) Part("literal", written[cursor..]);
            output = new(PartsType, entries.ToArray());
            return true;
        }
        finally
        {
            foreach (var pointer in strings) if (pointer != 0) Marshal.FreeHGlobal(pointer);
            if (result != 0) Function<Close>("ulistfmt_closeResult")(result);
            if (formatter != 0) Function<Close>("ulistfmt_close")(formatter);
        }
    }
    internal bool FormatRelative(string? locale, int width, bool automatic, int unit, string unitName, double number, bool parts, out ExpressionValue output)
    {
        output = ExpressionValue.Invalid;
        var status = 0;
        var formatter = Function<RelativeOpen>("ureldatefmt_open")(locale, 0, width, 0x100, ref status);
        nint result = 0;
        try
        {
            if (status > 0 || formatter == 0) return false;
            result = Function<OpenResult>("ureldatefmt_openResult")(ref status);
            if (status > 0 || result == 0) return false;
            Function<RelativeFormat>(automatic ? "ureldatefmt_formatToResult" : "ureldatefmt_formatNumericToResult")(formatter, number, unit, result, ref status);
            if (status > 0) return false;
            var value = Function<AsValue>("ureldatefmt_resultAsValue")(result, ref status);
            if (status > 0 || value == 0) return false;
            var pointer = text(value, out var length, ref status);
            if (status > 0 || pointer == 0) return false;
            var written = Marshal.PtrToStringUni(pointer, length)!;
            if (!parts) { output = ExpressionValue.Text(written); return true; }
            var numeric = Parts(value, number, written, false, ref status);
            if (status > 0 || numeric.IsInvalid) return false;
            output = new(PartsType, ((ExpressionValue[])numeric.Data!).Select(part => part.Member("type").ScalarText() == "literal" ? part
                : new ExpressionValue(PartType, new[] { part.Member("type"), part.Member("value"), ExpressionValue.Text(unitName) })).ToArray());
            return true;
        }
        finally { if (result != 0) Function<Close>("ureldatefmt_closeResult")(result); if (formatter != 0) Function<Close>("ureldatefmt_close")(formatter); }
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint ListOpen([MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, int type, int width, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void ListFormat(nint formatter, [In] nint[] strings, [In] int[] lengths, int count, nint result, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint RelativeOpen([MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, nint numberFormat, int width, int context, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void RelativeFormat(nint formatter, double offset, int unit, nint result, ref int status);
}
