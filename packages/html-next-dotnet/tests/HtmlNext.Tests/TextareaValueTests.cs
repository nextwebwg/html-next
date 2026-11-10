using AngleSharp.Html.Dom;
using AngleSharp.Html.Parser;
using HtmlNext;
using System.Text.Json;
using Xunit;

namespace HtmlNext.Tests;

public sealed class TextareaValueTests
{
    [Theory]
    [InlineData("{$value}", "\nLeading", "\nLeading")]
    [InlineData("{$value}", "\r\nLeading", "\nLeading")]
    [InlineData("{$value}", "<A>& Text", "<A>& Text")]
    [InlineData("{$value}\nTail", "", "\nTail")]
    [InlineData("\n\nAuthored", "", "\nAuthored")]
    public void PreservesInitialTextAcrossTheHtmlParserBoundary(string content, string value, string expected)
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-area\"><defs><prop name=\"value\" type=\"string\">Value.</prop></defs><textarea>" + content + "</textarea></template>");
        var html = Render(template, new { value });
        var area = (IHtmlTextAreaElement)new HtmlParser().ParseDocument(html).QuerySelector("textarea")!;
        Assert.Equal(expected, area.Value);
        Assert.Equal(expected, area.DefaultValue);
        Assert.Null(area.GetAttribute("data-html-next-form-defaults"));
    }

    [Fact]
    public void PreservesInitialNewlineFromValueContent()
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-area\"><defs><prop name=\"value\" type=\"string\">Value.</prop></defs><textarea $value=\"$value\"></textarea></template>");
        var html = Render(template, new { value = "\nLeading" });
        var area = (IHtmlTextAreaElement)new HtmlParser().ParseDocument(html).QuerySelector("textarea")!;
        Assert.Equal("\nLeading", area.Value);
    }

    [Theory]
    [InlineData("Live")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("<A>&\"\nB")]
    [InlineData("\nLeading")]
    [InlineData("A\r\nB")]
    public void SerializesCurrentTextAndTheAuthoredResetDefault(string? value)
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-area\"><defs><prop name=\"value\" type=\"string\">Value.</prop></defs><textarea .value=\"$value\">Base &amp; Text</textarea></template>");
        var html = Render(template, new { value });
        var area = (IHtmlTextAreaElement)new HtmlParser().ParseDocument(html).QuerySelector("textarea")!;
        Assert.Equal((value ?? "").Replace("\r\n", "\n"), area.Value);
        Assert.False(area.HasAttribute(".value"));
        using var defaults = JsonDocument.Parse(area.GetAttribute("data-html-next-form-defaults")!);
        Assert.Equal("Base & Text", defaults.RootElement.GetProperty("value").GetString());
    }

    [Fact]
    public void InvalidPropertiesRetainDynamicAuthoredText()
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-area\"><defs><prop name=\"name\" type=\"string\">Name.</prop></defs><textarea .value=\"1 / 0\">Before {$name}</textarea></template>");
        var html = Render(template, new { name = "<Name>&" });
        var area = (IHtmlTextAreaElement)new HtmlParser().ParseDocument(html).QuerySelector("textarea")!;
        Assert.Equal("Before <Name>&", area.Value);
        Assert.Null(area.GetAttribute("data-html-next-form-defaults"));
        Assert.False(area.HasAttribute(".value"));
    }

    [Fact]
    public void MatchingValuesDoNotNeedAResetRecord()
    {
        var html = Render(HtmlNextCompiler.Compile("<template component=\"x-area\"><textarea .value=\"'Base'\">Base</textarea></template>"));
        var area = new HtmlParser().ParseDocument(html).QuerySelector("textarea")!;
        Assert.Equal("Base", area.TextContent);
        Assert.Null(area.GetAttribute("data-html-next-form-defaults"));
    }

    [Fact]
    public void ReadonlyFromValueRetainsTheCurrentSdkAttributeMeaning()
    {
        var html = Render(HtmlNextCompiler.Compile("<template component=\"x-area\"><textarea from:value=\"'Value'\">Base</textarea></template>"));
        var area = (IHtmlTextAreaElement)new HtmlParser().ParseDocument(html).QuerySelector("textarea")!;
        Assert.Equal("Base", area.Value);
        Assert.Equal("Value", area.GetAttribute("value"));
    }

    private static string Render(CompiledTemplate template, object? inputs = null)
    {
        var html = template.Render(inputs);
        using var writer = new StringWriter(); template.Write(writer, inputs);
        Assert.Equal(html, writer.ToString());
        return html;
    }
}
