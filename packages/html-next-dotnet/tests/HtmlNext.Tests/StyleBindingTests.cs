using AngleSharp.Html.Parser;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class StyleBindingTests
{
    public static IEnumerable<object[]> Cases()
    {
        yield return ["<span style:--count=\"3\">Value</span>", "--count: 3"];
        yield return ["<span style=\"--count: 1 !important\" style:--count=\"3\">Value</span>", "--count: 3"];
        yield return ["<span style=\"--count: 1 !important\" style:--count=\"1 / 0\">Value</span>", "--count: 1 !important"];
        yield return ["<span style=\"--count: 1\" style:--count=\"null\">Value</span>", ""];
        yield return ["<span style:--count=\"false\">Value</span>", "--count: false"];
        yield return ["<span style=\"height: 1px\" style:height=\"3\">Value</span>", "height: 1px"];
        yield return ["<span style:top=\"3px\">Value</span>", "top: 3px"];
        yield return ["<span style=\"top: 1px\" style:top=\"'bad'\">Value</span>", "top: 1px"];
        yield return ["<span style:--count=\"3\" from:style=\"'--count: 4'\">Value</span>", "--count: 4"];
        yield return ["<span from:style=\"'--count: 4'\" style:--count=\"3\">Value</span>", "--count: 3"];
        yield return ["<span style=\"margin: 1px 2px !important\" style:margin-left=\"3px\">Value</span>", "margin-top: 1px !important; margin-right: 2px !important; margin-bottom: 1px !important; margin-left: 3px"];
        yield return ["<span style=\"--count: 2\" style:--count=\"'1; color: blue'\">Value</span>", "--count: 2"];
        yield return ["<span style:--count=\"'&quot;a;b&quot;'\">Value</span>", "--count: \"a;b\""];
        yield return ["<span style=\"--empty: ; --count: 1\" style:--count=\"3\">Value</span>", "--empty: ; --count: 3"];
        yield return ["<span style:--empty=\"' '\">Value</span>", "--empty:"];
        yield return ["<span style=\"padding: 1px 2px\" style:padding-left=\"null\">Value</span>", "padding-top: 1px; padding-right: 2px; padding-bottom: 1px"];
        yield return ["<span style=\"margin: 1px !important\" style:margin=\"'3px'\">Value</span>", "margin-top: 3px; margin-right: 3px; margin-bottom: 3px; margin-left: 3px"];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void AppliesKeyedPropertiesAndWholeStyleWritesInOrder(string body, string expectedStyle)
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-style\">" + body + "</template>");
        void Check(string html)
        {
            var element = new HtmlParser().ParseDocument(html).QuerySelector("span")!;
            Assert.True(element.HasAttribute("style"));
            static string Normalize(string value) => value.Trim().TrimEnd(';').Trim().Replace("--empty:  ;", "--empty: ;", StringComparison.Ordinal);
            Assert.Equal(Normalize(expectedStyle), Normalize(element.GetAttribute("style")!));
            Assert.Equal("Value", element.TextContent);
        }
        Check(template.Render());
        using var writer = new StringWriter(); template.Write(writer); Check(writer.ToString());
    }

    [Fact]
    public void InvalidUrlTokensRetainAnExistingCustomValue()
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-url-style\"><defs><prop name=\"value\" type=\"string\">Value.</prop></defs><b style=\"--count: 1\" style:--count=\"$value\">Value</b></template>");
        foreach (var value in new[] { "url(a b)", "url(a\"b)", "var(--v, url(a b))", "u\\72l(a b)" })
        {
            var actual = new HtmlParser().ParseDocument(template.Render(new { value })).QuerySelector("b")!.GetAttribute("style");
            Assert.Equal("--count: 1", actual);
        }
    }

    [Fact]
    public void BorderWritesPreserveItsResetOnlyLonghands()
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-border-style\"><b style=\"border: 1px solid red !important\" style:border-color=\"'blue'\">Value</b></template>");
        var style = new HtmlParser().ParseDocument(template.Render()).QuerySelector("b")!.GetAttribute("style")!;
        Assert.Contains("border-image-source: none !important", style);
        Assert.Contains("border-image-slice: 100% !important", style);
        Assert.Contains("border-image-width: 1 !important", style);
        Assert.Contains("border-image-outset: 0 !important", style);
        Assert.Contains("border-image-repeat: stretch !important", style);
    }

    [Fact]
    public void KeepsAnUnresolvedShorthandWhenAnotherPropertyChanges()
    {
        var template = HtmlNextCompiler.Compile("<template component=\"x-pending-style\"><b style=\"background: var(--surface); --surface: red\" style:--count=\"3\">Value</b></template>");
        Assert.Contains("background: var(--surface)", new HtmlParser().ParseDocument(template.Render()).QuerySelector("b")!.GetAttribute("style"));
    }

    [Fact]
    public void FoldsStyleModifiersBeforeTheReceivingPropSeedsState()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-leaf"><defs><prop name="style" type="string">Style.</prop><state name="initial" type="string" from="$style"></state></defs><b from:style="$style" from:data-initial="$initial">Leaf</b></template>
            <template component="x-page"><main><x-leaf style="--count: 1 !important" style:--count="3"></x-leaf></main></template>
            """).Template("x-page");
        var element = new HtmlParser().ParseDocument(template.Render()).QuerySelector("b")!;
        Assert.Equal("--count: 3", element.GetAttribute("style")!.TrimEnd(';'));
        Assert.Equal(element.GetAttribute("style"), element.GetAttribute("data-initial"));
    }

    [Fact]
    public void ForwardsStyleModifiersAcrossDelegatedRoots()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-leaf"><b style:--inner="2">Leaf</b></template>
            <template component="x-wrap"><x-leaf style:--middle="3"></x-leaf></template>
            <template component="x-page"><main><x-wrap style="--outer: 1" style:--outer="4"></x-wrap></main></template>
            """).Template("x-page");
        Assert.Equal("--outer: 4; --middle: 3; --inner: 2", new HtmlParser().ParseDocument(template.Render()).QuerySelector("b")!.GetAttribute("style")!.TrimEnd(';'));
    }
}
