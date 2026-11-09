using System.Text.Json;
using System.Runtime.InteropServices;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class DateFormattingTests
{
    [DllImport("/usr/lib/libicucore.A.dylib", EntryPoint = "u_getVersion", CallingConvention = CallingConvention.Cdecl)]
    private static extern void GetMacIcuVersion([Out] byte[] version);

    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures/date-formatting.json")));
        foreach (var item in document.RootElement.EnumerateArray()) yield return [item.GetProperty("name").GetString()!, item.Clone()];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesCivilValueAndNativeDateFormatterBehavior(string name, JsonElement fixture)
    {
        var operation = fixture.GetProperty("operation").GetString()!;
        var expression = operation + "($value";
        if (operation == "formatRange") expression += ", $end";
        if (fixture.GetProperty("formatter").ValueKind != JsonValueKind.Null) expression += ", " + fixture.GetProperty("formatter").GetRawText();
        expression += ", " + fixture.GetProperty("options").GetRawText() + ", " + fixture.GetProperty("locale").GetRawText() + ")";
        var type = fixture.GetProperty("inputType").GetString()!;
        var declarations = "<defs><prop name=\"value\" type=\"" + type + "\">Value.</prop>"
            + (operation == "formatRange" ? "<prop name=\"end\" type=\"" + type + "\">End.</prop>" : "") + "</defs>";
        var parts = operation == "formatParts";
        var body = parts ? "<output><span $each=\"part of " + expression.Replace("\"", "&quot;") + "\">{$part.type}:{$part.value}</span></output>"
            : "<output>{" + expression + "}</output>";
        var template = HtmlNextCompiler.Compile("<template component=\"x-date\">" + declarations + body + "</template>", name);
        var input = new Dictionary<string, object?> { ["value"] = fixture.GetProperty("value") };
        if (operation == "formatRange") input["end"] = fixture.GetProperty("end");
        var expectedValue = fixture.GetProperty("expected");
        if (OperatingSystem.IsMacOS() && fixture.TryGetProperty("platformExpected", out var platforms))
        {
            var version = new byte[4];
            GetMacIcuVersion(version);
            if (platforms.TryGetProperty($"macos-icu-{version[0]}.{version[1]}", out var platform)) expectedValue = platform;
        }
        var expected = "<output>" + (expectedValue.ValueKind == JsonValueKind.Null ? "" : parts
            ? string.Concat(expectedValue.EnumerateArray().Select(part => "<span>" + part.GetProperty("type").GetString() + ":" + part.GetProperty("value").GetString() + "</span>"))
            : expectedValue.GetString()) + "</output>";
        Assert.Equal(expected, template.Render(input));
        using var writer = new StringWriter(); template.Write(writer, input);
        Assert.Equal(expected, writer.ToString());
    }
}
