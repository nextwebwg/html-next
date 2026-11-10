using System.Text.Json;
using System.Xml.Linq;
using System.Runtime.InteropServices;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class DurationFormattingTests
{
    [DllImport("/usr/lib/libicucore.A.dylib", EntryPoint = "u_getVersion", CallingConvention = CallingConvention.Cdecl)]
    private static extern void GetMacIcuVersion([Out] byte[] version);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void NativeVersion([Out] byte[] version);
    private static string? Platform()
    {
        var version = new byte[4];
        if (OperatingSystem.IsMacOS()) { GetMacIcuVersion(version); return $"macos-icu-{version[0]}.{version[1]}"; }
        if (!OperatingSystem.IsLinux() || !NativeLibrary.TryLoad("libicuuc.so.74", out var library)) return null;
        try
        {
            Marshal.GetDelegateForFunctionPointer<NativeVersion>(NativeLibrary.GetExport(library, "u_getVersion_74"))(version);
            return $"linux-icu-{version[0]}.{version[1]}";
        }
        finally { NativeLibrary.Free(library); }
    }
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures/duration-formatting.json")));
        foreach (var item in document.RootElement.EnumerateArray()) yield return [item.GetProperty("name").GetString()!, item.Clone()];
    }
    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesDurationRecordsOptionsAndStructuredParts(string name, JsonElement fixture)
    {
        var operation = fixture.GetProperty("operation").GetString()!;
        var typed = fixture.GetProperty("inputType").GetString() == "duration";
        var expression = operation + "(" + (typed ? "$value" : fixture.GetProperty("value").GetRawText());
        if (fixture.GetProperty("formatter").ValueKind != JsonValueKind.Null) expression += ", " + fixture.GetProperty("formatter").GetRawText();
        expression += ", " + fixture.GetProperty("options").GetRawText() + ", " + fixture.GetProperty("locale").GetRawText() + ")";
        var declarations = typed ? "<defs><prop name=\"value\" type=\"duration\">Value.</prop></defs>" : "";
        var parts = operation == "formatParts";
        var body = parts ? "<output><span $each=\"part of " + System.Net.WebUtility.HtmlEncode(expression) + "\">{$part.type}:{$part.value}:{$part.unit}</span></output>"
            : "<output>{" + expression + "}</output>";
        var template = HtmlNextCompiler.Compile("<template component=\"x-duration\">" + declarations + body + "</template>", name);
        var input = new Dictionary<string, object?> { ["value"] = fixture.GetProperty("value") };
        var value = fixture.GetProperty("expected");
        if (Platform() is { } key && fixture.TryGetProperty("platformExpected", out var platforms) && platforms.TryGetProperty(key, out var platform)) value = platform;
        var expectedElement = new XElement("output", new XText(""));
        if (value.ValueKind != JsonValueKind.Null)
        {
            if (parts) expectedElement.Add(value.EnumerateArray().Select(part => new XElement("span", part.GetProperty("type").GetString() + ":" + part.GetProperty("value").GetString() + ":" + (part.TryGetProperty("unit", out var unit) ? unit.GetString() : ""))));
            else expectedElement.Add(value.GetString());
        }
        var expected = expectedElement.ToString(SaveOptions.DisableFormatting);
        Assert.Equal(expected, template.Render(input));
        using var writer = new StringWriter(); template.Write(writer, input);
        Assert.Equal(expected, writer.ToString());
    }
    [Fact]
    public void FormatsBoundOpenRecordsAndFallsBackFromAlgorithmicNumbering()
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-bound-duration\"><defs><prop name=\"value\" type=\"object\" open>Value.</prop></defs><output>{format($value, 'duration', { style: 'digital' }, 'en-US')}</output></template>");
        Assert.Equal("<output>0:02:03</output>", template.Render(new { value = new { minutes = 2, seconds = 3 } }));
        var number = HtmlNextCompiler.Compile("<template component=\"x-numbering\"><output>{format(1234, { numberingSystem: 'roman' }, 'en-US')}:{format(1234, {}, 'en-US-u-nu-roman')}</output></template>");
        Assert.Equal("<output>1,234:1,234</output>", number.Render());
    }

    [Fact]
    public void DurationRangesRemainInvalid()
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-invalid-duration\"><output>{default(formatRange({ seconds: 1 }, { seconds: 2 }, 'duration', {}, 'en-US'), 'fallback')}</output></template>");
        Assert.Equal("<output></output>", template.Render());
    }
}
