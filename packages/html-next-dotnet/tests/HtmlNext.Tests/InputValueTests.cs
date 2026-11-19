using AngleSharp.Html.Parser;
using HtmlNext;
using System.Text.Json;
using Xunit;

namespace HtmlNext.Tests;

public sealed class InputValueTests
{
    [Theory]
    [InlineData("'Live'", "Live")]
    [InlineData("null", "")]
    [InlineData("false", "false")]
    [InlineData("17", "17")]
    [InlineData("[]", "")]
    [InlineData("[1, 2]", "1,2")]
    [InlineData("[null, [1, 2], {}]", ",1,2,[object Object]")]
    [InlineData("{}", "[object Object]")]
    public void SerializesInitialInputPropertyAndItsAuthoredResetDefault(string expression, string current)
    {
        var html = Render("<input value=\"Base\" .value=\"" + expression + "\">");
        var input = new HtmlParser().ParseDocument(html).QuerySelector("input")!;
        Assert.False(input.HasAttribute(".value"));
        Assert.Equal(current, input.GetAttribute("value"));
        using var defaults = JsonDocument.Parse(input.GetAttribute("data-html-next-form-defaults")!);
        Assert.Equal("Base", defaults.RootElement.GetProperty("value").GetString());
        Assert.True(defaults.RootElement.GetProperty("valuePresent").GetBoolean());
    }

    [Theory]
    [InlineData("text", true, "Live", "Base")]
    [InlineData("text", false, "Live", "Base")]
    [InlineData("checkbox", true, "Base", null)]
    [InlineData("checkbox", false, "Live", null)]
    [InlineData("hidden", true, "Base", null)]
    [InlineData("hidden", false, "Live", null)]
    public void ComposesPropertyWritesWithOrderedAttributes(string type, bool propertyFirst, string expected, string? reset)
    {
        var property = ".value=\"'Live'\"";
        var attribute = "from:value=\"'Base'\"";
        var html = Render("<input type=\"" + type + "\" " + (propertyFirst ? property + " " + attribute : attribute + " " + property) + ">");
        var input = new HtmlParser().ParseDocument(html).QuerySelector("input")!;
        Assert.Equal(expected, input.GetAttribute("value"));
        if (reset is null) Assert.Null(input.GetAttribute("data-html-next-form-defaults"));
        else
        {
            using var defaults = JsonDocument.Parse(input.GetAttribute("data-html-next-form-defaults")!);
            Assert.Equal(reset, defaults.RootElement.GetProperty("value").GetString());
        }
    }

    [Fact]
    public void ComposesValueAndCheckedResetRecords()
    {
        var html = Render("<input value=\"Base\" checked .value=\"'Live'\" .checked=\"false\">");
        var input = new HtmlParser().ParseDocument(html).QuerySelector("input")!;
        using var defaults = JsonDocument.Parse(input.GetAttribute("data-html-next-form-defaults")!);
        Assert.Equal("Base", defaults.RootElement.GetProperty("value").GetString());
        Assert.True(defaults.RootElement.GetProperty("checked").GetBoolean());
        Assert.False(input.HasAttribute("checked"));
    }

    [Fact]
    public void InvalidPropertyExpressionsKeepTheAuthoredValue()
    {
        var html = Render("<input value=\"Base\" .value=\"1 / 0\">");
        var input = new HtmlParser().ParseDocument(html).QuerySelector("input")!;
        Assert.Equal("Base", input.GetAttribute("value"));
        Assert.Null(input.GetAttribute("data-html-next-form-defaults"));
        Assert.False(input.HasAttribute(".value"));
    }

    [Fact]
    public void EmptyInitialValueDoesNotAddAnOtherwiseAbsentResetAttribute()
    {
        var input = new HtmlParser().ParseDocument(Render("<input .value=\"null\">")).QuerySelector("input")!;
        Assert.False(input.HasAttribute("value"));
        Assert.False(input.HasAttribute(".value"));
        Assert.False(input.HasAttribute("data-html-next-form-defaults"));
    }

    [Fact]
    public void RecordsAnAbsentAuthoredResetAttribute()
    {
        var input = new HtmlParser().ParseDocument(Render("<input .value=\"'Live'\">")).QuerySelector("input")!;
        using var defaults = JsonDocument.Parse(input.GetAttribute("data-html-next-form-defaults")!);
        Assert.Equal("", defaults.RootElement.GetProperty("value").GetString());
        Assert.False(defaults.RootElement.GetProperty("valuePresent").GetBoolean());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ForwardedAttributesRemainTheResetDefaults(bool propertyFirst)
    {
        var attributes = propertyFirst ? ".value=\"$current\" $attributes" : "$attributes .value=\"$current\"";
        var source = "<template component=\"x-field\" noforward><defs><prop name=\"current\" type=\"string\" default=\"Live\">Current.</prop></defs><input " + attributes + "></template><template component=\"x-parent\"><main><x-field value=\"Base\"></x-field></main></template>";
        var input = new HtmlParser().ParseDocument(HtmlNextCompiler.CompileResource(source).Template("x-parent").Render()).QuerySelector("input")!;
        Assert.Equal("Live", input.GetAttribute("value"));
        using var defaults = JsonDocument.Parse(input.GetAttribute("data-html-next-form-defaults")!);
        Assert.Equal("Base", defaults.RootElement.GetProperty("value").GetString());
        Assert.True(defaults.RootElement.GetProperty("valuePresent").GetBoolean());
    }

    [Fact]
    public void FileInputsAcceptOnlyAnEmptyPropertyValue()
    {
        var input = new HtmlParser().ParseDocument(Render("<input type=\"file\" value=\"Base\" .value=\"''\">")).QuerySelector("input")!;
        Assert.Equal("Base", input.GetAttribute("value"));
        Assert.Null(input.GetAttribute("data-html-next-form-defaults"));
        Assert.False(input.HasAttribute(".value"));
        Assert.Equal("HNCS002", Assert.Throws<HtmlNextException>(() => Render("<input type=\"file\" .value=\"'File'\">")).Code);
    }

    [Fact]
    public void AClassNamedValueDoesNotChangeTheResetAttribute()
    {
        var input = new HtmlParser().ParseDocument(Render("<input value=\"Base\" .value=\"'Live'\" class:value=\"true\">")).QuerySelector("input")!;
        Assert.Equal("Live", input.GetAttribute("value"));
        Assert.Equal("value", input.GetAttribute("class"));
        using var defaults = JsonDocument.Parse(input.GetAttribute("data-html-next-form-defaults")!);
        Assert.Equal("Base", defaults.RootElement.GetProperty("value").GetString());
    }

    private static string Render(string markup)
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-input\">" + markup + "</template>");
        var html = template.Render();
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(html, writer.ToString());
        return html;
    }
}
