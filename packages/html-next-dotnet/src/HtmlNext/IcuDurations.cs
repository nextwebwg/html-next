using System.Runtime.InteropServices;

namespace HtmlNext;

internal sealed partial class IcuFormatters
{
    internal string DurationSeparator(string? locale)
    {
        var status = 0;
        var system = Function<OpenLocale>("unumsys_open")(locale, ref status);
        string numbering;
        try { numbering = status <= 0 && system != 0 ? Marshal.PtrToStringUTF8(Function<NativeName>("unumsys_getName")(system))! : "latn"; }
        finally { if (system != 0) Function<Close>("unumsys_close")(system); }
        var current = locale;
        while (true)
        {
            var handles = new nint[4];
            status = 0;
            try
            {
                handles[0] = Function<ResourceOpen>("ures_open")(null, current, ref status);
                var get = Function<ResourceKey>("ures_getByKey");
                for (var index = 1; index < handles.Length && status <= 0; index++)
                    handles[index] = get(handles[index - 1], index switch { 1 => "NumberElements", 2 => numbering, _ => "symbols" }, 0, ref status);
                if (status <= 0)
                {
                    var pointer = Function<ResourceString>("ures_getStringByKey")(handles[^1], "timeSeparator", out var length, ref status);
                    if (status <= 0 && pointer != 0) return Marshal.PtrToStringUni(pointer, length)!;
                }
            }
            finally { for (var index = handles.Length - 1; index >= 0; index--) if (handles[index] != 0) Function<Close>("ures_close")(handles[index]); }
            if (current == "root") return ":";
            current = current?.Split('@')[0];
            var separator = current?.LastIndexOf('_') ?? -1;
            current = separator >= 0 ? current![..separator] : "root";
        }
    }
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint NativeName(nint value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint ResourceOpen([MarshalAs(UnmanagedType.LPUTF8Str)] string? package, [MarshalAs(UnmanagedType.LPUTF8Str)] string? locale, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint ResourceKey(nint resource, [MarshalAs(UnmanagedType.LPUTF8Str)] string key, nint target, ref int status);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate nint ResourceString(nint resource, [MarshalAs(UnmanagedType.LPUTF8Str)] string key, out int length, ref int status);
}
