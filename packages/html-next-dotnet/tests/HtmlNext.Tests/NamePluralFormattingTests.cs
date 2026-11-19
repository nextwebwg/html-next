using System.Text.Json;
using System.Xml.Linq;
using System.Runtime.InteropServices;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class NamePluralFormattingTests
{
    [DllImport("/usr/lib/libicucore.A.dylib", EntryPoint = "u_getVersion", CallingConvention = CallingConvention.Cdecl)]
    private static extern void GetMacIcuVersion([Out] byte[] version);

    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures/name-plural-formatting.json")));
        foreach (var item in document.RootElement.EnumerateArray()) yield return [item.GetProperty("name").GetString()!, item.Clone()];
    }
    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesNativeDisplayNamesAndPluralMessages(string name, JsonElement fixture)
    {
        var expression = "format($value, " + fixture.GetProperty("formatter").GetRawText() + ", " + fixture.GetProperty("options").GetRawText() + ", " + fixture.GetProperty("locale").GetRawText() + ")";
        var type = fixture.GetProperty("inputType").GetString()!;
        var template = HtmlNextCompiler.Compile("<template component=\"x-name-plural\"><defs><prop name=\"value\" type=\"" + type + "\">Value.</prop></defs><output>{default(" + System.Net.WebUtility.HtmlEncode(expression) + ", 'fallback')}</output></template>", name);
        var expected = fixture.GetProperty("status").GetString() switch { "absent" => "fallback", "invalid" => "", _ => fixture.GetProperty("expected").GetString()! };
        if (OperatingSystem.IsMacOS() && fixture.TryGetProperty("platformExpected", out var platforms))
        {
            var version = new byte[4]; GetMacIcuVersion(version);
            if (platforms.TryGetProperty($"macos-icu-{version[0]}.{version[1]}", out var platform)) expected = platform.GetString()!;
        }
        var html = new XElement("output", new XText(expected)).ToString(SaveOptions.DisableFormatting);
        var input = new Dictionary<string, object?> { ["value"] = fixture.GetProperty("value") };
        Assert.Equal(html, template.Render(input));
        using var writer = new StringWriter(); template.Write(writer, input);
        Assert.Equal(html, writer.ToString());
    }
    [Theory]
    [InlineData("formatParts('US', 'displayName', { type: 'region' }, 'en-US')[0].type")]
    [InlineData("formatParts(1, 'plural', { forms: { other: '#' } }, 'en-US')[0].type")]
    [InlineData("formatRange('US', 'CA', 'displayName', { type: 'region' }, 'en-US')")]
    [InlineData("formatRange(1, 2, 'plural', { forms: { other: '#' } }, 'en-US')")]
    [InlineData("format('1', 'plural', { forms: { other: '#' } }, 'en-US')")]
    public void RejectsUnsupportedOperationsAndNumericStringCoercion(string expression)
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-invalid-name-plural\"><output>{default(" + expression + ", 'fallback')}</output></template>");
        Assert.Equal("<output></output>", template.Render());
    }

}
