using System.Text.Json;
using System.Xml.Linq;
using System.Runtime.InteropServices;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class MessageFormattingTests
{
    [DllImport("/usr/lib/libicucore.A.dylib", EntryPoint = "u_getVersion", CallingConvention = CallingConvention.Cdecl)]
    private static extern void GetMacIcuVersion([Out] byte[] version);

    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures/message-formatting.json")));
        foreach (var item in document.RootElement.EnumerateArray()) yield return [item.GetProperty("name").GetString()!, item.Clone()];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesNativeListAndRelativeTimeBehavior(string name, JsonElement fixture)
    {
        var operation = fixture.GetProperty("operation").GetString()!;
        var expression = operation + "($value";
        if (fixture.GetProperty("formatter").ValueKind != JsonValueKind.Null) expression += ", " + fixture.GetProperty("formatter").GetRawText();
        expression += ", " + fixture.GetProperty("options").GetRawText() + ", " + fixture.GetProperty("locale").GetRawText() + ")";
        var type = fixture.GetProperty("inputType").GetString() == "list" ? "list(string)" : "number";
        var declarations = "<defs><prop name=\"value\" type=\"" + type + "\">Value.</prop></defs>";
        var parts = operation == "formatParts";
        var body = parts ? "<output><span $each=\"part of " + expression.Replace("\"", "&quot;") + "\">{$part.type}:{$part.value}:{$part.unit}</span></output>"
            : "<output>{" + expression + "}</output>";
        var template = HtmlNextCompiler.Compile("<template component=\"x-message\">" + declarations + body + "</template>", name);
        var input = new Dictionary<string, object?> { ["value"] = fixture.GetProperty("negativeZero").GetBoolean() ? -0.0 : fixture.GetProperty("value") };
        var value = fixture.GetProperty("expected");
        if (OperatingSystem.IsMacOS() && fixture.TryGetProperty("platformExpected", out var platforms))
        {
            var version = new byte[4]; GetMacIcuVersion(version);
            if (platforms.TryGetProperty($"macos-icu-{version[0]}.{version[1]}", out var platform)) value = platform;
        }
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
    public void InfersOnlyDeclaredStringOrKeywordLists()
    {
        static CompiledTemplate Template(string type, string expression) => HtmlNextCompiler.Compile("<template component=\"x-inference\"><defs><prop name=\"items\" type=\"list(" + type + ")\">Items.</prop></defs><output>{" + expression + "}</output></template>");
        Assert.Equal("<output>one and two</output>", Template("keyword", "format($items, {}, 'en-US')").Render(new { items = new[] { "one", "two" } }));
        Assert.Equal("<output></output>", Template("number", "format($items, {}, 'en-US')").Render(new { items = new[] { 1, 2 } }));
        var dates = new { items = new[] { "2024-01-01", "2024-01-02" } };
        Assert.Equal("<output></output>", Template("date", "format($items, {}, 'en-US')").Render(dates));
        Assert.Equal("<output>2024-01-01 and 2024-01-02</output>", Template("date", "format($items, 'list', {}, 'en-US')").Render(dates));
    }

    [Theory]
    [InlineData("format([1, 2], 'list', {}, 'en-US')")]
    [InlineData("format(3, 'relativeTime', { unit: ['day'] }, 'en-US')")]
    [InlineData("formatRange(['one'], ['two'], 'list', {}, 'en-US')")]
    [InlineData("formatRange(1, 2, 'relativeTime', { unit: 'day' }, 'en-US')")]
    public void InvalidInputsAndUnsupportedRangesRemainInvalid(string expression)
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-invalid-message\"><output>{default(" + expression + ", 'fallback')}</output></template>");
        Assert.Equal("<output></output>", template.Render());
    }

}
