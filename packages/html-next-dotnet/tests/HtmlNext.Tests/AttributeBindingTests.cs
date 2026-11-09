using HtmlNext;
using System.Text.Json;
using Xunit;

namespace HtmlNext.Tests;

public sealed class AttributeBindingTests
{
    public static IEnumerable<object[]> SharedFixtures()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "attribute-bindings.json")));
        foreach (var entry in document.RootElement.EnumerateArray()) yield return
            [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty("model").GetRawText(), entry.GetProperty("expected").GetString()!];
    }

    [Theory]
    [MemberData(nameof(SharedFixtures))]
    public void MatchesSharedAttributeFixtures(string name, string source, string model, string expected)
    {
        using var document = JsonDocument.Parse(model);
        EqualOutput(HtmlNextCompiler.Compile(source, name + ".html"), expected, document.RootElement);
    }

    [Theory]
    [InlineData("true", " title=\"\" data-value=\"\" id=\"\"")]
    [InlineData("false", "")]
    [InlineData("null", "")]
    [InlineData("0", " title=\"0\" data-value=\"0\" id=\"0\"")]
    [InlineData("''", " title=\"\" data-value=\"\" id=\"\"")]
    [InlineData("'false'", " title=\"false\" data-value=\"false\" id=\"false\"")]
    public void OrdinaryAttributesUsePresenceForBooleansAndPreserveStrings(string expression, string attributes)
    {
        var template = Compile($"<b from:title=\"{expression}\" from:data-value=\"{expression}\" from:id=\"{expression}\">Value</b>");
        EqualOutput(template, "<b" + attributes + ">Value</b>");
    }

    [Theory]
    [InlineData(false, "")]
    [InlineData(true, " title=\"\" data-value=\"\"")]
    public void DirectBooleanPathsUseOrdinaryPresence(bool active, string attributes)
    {
        var template = Compile("<b from:title=\"$active\" from:data-value=\"$active\">Value</b>", "<prop name=\"active\" type=\"boolean\" default=\"false\">Active.</prop>");
        EqualOutput(template, "<b" + attributes + ">Value</b>", new { active });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DirectPathsAndExpressionsShareEnumeratedBooleanSerialization(bool value)
    {
        var template = Compile("<b from:title=\"$active\" from:aria-expanded=\"$active\" from:contenteditable=\"not(not($active))\" from:draggable=\"$active\" from:spellcheck=\"$active\">Value</b>",
            "<prop name=\"active\" type=\"boolean\" default=\"false\">Active.</prop>");
        var token = value ? "true" : "false";
        EqualOutput(template, $"<b{(value ? " title=\"\"" : "")} aria-expanded=\"{token}\" contenteditable=\"{token}\" draggable=\"{token}\" spellcheck=\"{token}\">Value</b>", new { active = value });
    }

    [Theory]
    [InlineData("'false'", "false")]
    [InlineData("2", "2")]
    [InlineData("true", "")]
    public void NativeBooleanAttributesKeepTheWrittenAttributeValue(string expression, string expected)
    {
        EqualOutput(Compile($"<button from:disabled=\"{expression}\">Value</button>"), $"<button disabled=\"{expected}\">Value</button>");
    }

    [Fact]
    public void ListsJoinTextWithoutTreatingObjectsOrNullAsText()
    {
        EqualOutput(Compile("<b from:class=\"['a', false, 0, null, ['b', 'c'], {x: 1}]\">Value</b>"), "<b class=\"a false 0  b c \">Value</b>");
        var template = Compile("<b from:class=\"$tokens\">Value</b>", "<prop name=\"tokens\" type=\"list(string)\">Tokens.</prop>");
        EqualOutput(template, "<b class=\"a &amp; &quot;b&quot;\">Value</b>", new { tokens = new[] { "a", "&", "\"b\"" } });
    }

    [Theory]
    [InlineData("https://example.test/a?x=1&y=2", " href=\"https://example.test/a?x=1&amp;y=2\"")]
    [InlineData("../relative", " href=\"../relative\"")]
    [InlineData("", " href=\"\"")]
    [InlineData("java\nscript:alert(1)", "")]
    [InlineData(" \u0000Da\tTa:text/html,test", "")]
    [InlineData("VBSCRIPT:run()", "")]
    [InlineData("mailto:a@example.test", " href=\"mailto:a@example.test\"")]
    public void UrlBindingsDropExecutableSchemesAfterNormalizingAsciiControls(string destination, string attribute)
    {
        var template = Compile("<a from:href=\"$destination\">Open</a>", "<prop name=\"destination\" type=\"string\">Destination.</prop>");
        EqualOutput(template, "<a" + attribute + ">Open</a>", new { destination });
    }

    [Fact]
    public void UrlFilteringAppliesToAllUrlTargetsAndJoinedExpressions()
    {
        var template = Compile("<div><img from:src=\"$url\" from:poster=\"$url\"><form from:action=\"$url\"><button from:formaction=\"$url\">Submit</button></form><a from:href=\"['java', 'script:alert(1)']\">Open</a></div>",
            "<prop name=\"url\" type=\"string\">URL.</prop>");
        EqualOutput(template, "<div><img><form><button>Submit</button></form><a>Open</a></div>", new { url = "javascript:alert(1)" });
    }

    [Fact]
    public void SvgBindingsUseTheHtmlParsersAttributeNameAdjustments()
    {
        EqualOutput(Compile("<div><svg from:viewBox=\"'0 0 10 10'\"><path from:d=\"'M0 0'\" from:preserveAspectRatio=\"'none'\"></path><use from:xlink:href=\"'#icon'\"></use></svg></div>"),
            "<div><svg viewBox=\"0 0 10 10\"><path d=\"M0 0\" preserveAspectRatio=\"none\"></path><use xlink:href=\"#icon\"></use></svg></div>");
    }

    [Theory]
    [InlineData("#icon", " xlink:href=\"#icon\" xml:lang=\"en\"")]
    public void LiteralForeignAttributesKeepTheirNamespacePrefixes(string href, string attributes)
    {
        EqualOutput(Compile($"<div><svg><use xlink:href=\"{href}\" xml:lang=\"en\"></use></svg></div>"), "<div><svg><use" + attributes + "></use></svg></div>");
    }

    [Theory]
    [InlineData("srcdoc")]
    [InlineData("innerhtml")]
    [InlineData("outerhtml")]
    [InlineData("textcontent")]
    [InlineData("innertext")]
    [InlineData("onclick")]
    public void RawContentAndExecutableEventTargetsAreRejected(string name)
    {
        Assert.Throws<HtmlNextException>(() => Compile($"<div from:{name}=\"'text'\"></div>"));
    }

    [Fact]
    public void UnsafeLiteralUrlsAreRejectedDuringCompilation()
    {
        Assert.Throws<HtmlNextException>(() => Compile("<a href=\"java&#x0A;script:alert(1)\">Open</a>"));
    }

    [Fact]
    public void InvalidStructuredReadsRetainTheirLiteralFallbackAndValidSiblingsRender()
    {
        var template = Compile("<div><b title=\"fallback\" from:title=\"$draft.title\">Value</b><i from:title=\"$draft.other\"></i></div>",
            "<state name=\"draft\" type=\"object({ title: string, other: string })\" from=\"{ title: 7, other: 'valid' }\"></state>");
        EqualOutput(template, "<div><b title=\"fallback\">Value</b><i title=\"valid\"></i></div>");
    }

    [Fact]
    public async Task IteratedFallbacksAreEscapedAndIsolatedAcrossConcurrentRenders()
    {
        var template = Compile("<div><b $each=\"row of $rows\" title=\"A &amp; &quot;fallback&quot;\" from:title=\"$row.amount / $row.divisor\"></b></div>",
            "<prop name=\"rows\" type=\"list(object({ amount: number, divisor: number }))\">Rows.</prop>");
        await Task.WhenAll(Enumerable.Range(1, 16).Select(amount => Task.Run(() =>
            EqualOutput(template, $"<div><b title=\"A &amp; &quot;fallback&quot;\"></b><b title=\"{amount}\"></b></div>",
                new { rows = new[] { new { amount, divisor = 0 }, new { amount, divisor = 1 } } }))));
    }

    [Fact]
    public void StreamingUrlFallbacksUseOneSnapshotWithoutReportingInvalidAsTypeErrors()
    {
        var template = Compile("<div><a href=\"#fallback\" from:href=\"concat($source.prefix, 1 / $source.divisor)\"></a><a href=\"#fallback\" from:href=\"join([$source.prefix, concat(1 / $source.divisor)], '')\"></a></div>",
            "<prop name=\"source\" type=\"object({ prefix: string, divisor: number })\">Source.</prop>");
        foreach (var write in new[] { false, true })
        {
            var source = new AttributeSource();
            var diagnostics = new List<HtmlNextDiagnostic>();
            using var writer = new StringWriter();
            if (write) template.Write(writer, new { source }, onDiagnostic: diagnostics.Add);
            var output = write ? writer.ToString() : template.Render(new { source }, onDiagnostic: diagnostics.Add);
            Assert.Equal("<div><a href=\"#fallback\"></a><a href=\"#fallback\"></a></div>", output);
            Assert.Equal(1, source.PrefixReads);
            Assert.Equal(1, source.DivisorReads);
            Assert.Empty(diagnostics);
        }
    }

    public sealed class AttributeSource
    {
        public int PrefixReads;
        public int DivisorReads;
        public string prefix { get { PrefixReads++; return "#"; } }
        public double divisor { get { DivisorReads++; return 0; } }
    }

    [Theory]
    [InlineData("href=\"javascript:alert(1)\" from:href=\"'#safe'\"")]
    [InlineData("from:href=\"'#safe'\" href=\"javascript:alert(1)\"")]
    public void ABindingDoesNotHideAnUnsafeLiteralUrl(string attributes)
    {
        Assert.Throws<HtmlNextException>(() => Compile("<a " + attributes + ">Open</a>"));
    }

    private static CompiledTemplate Compile(string body, string declarations = "") => HtmlNextCompiler.Compile(
        $"<template component=\"x-attributes\"><defs>{declarations}</defs>{body}</template>", "attributes.html");

    private static void EqualOutput(CompiledTemplate template, string expected, object? model = null)
    {
        Assert.Equal(expected, template.Render(model));
        using var writer = new StringWriter(); template.Write(writer, model);
        Assert.Equal(expected, writer.ToString());
    }
}
