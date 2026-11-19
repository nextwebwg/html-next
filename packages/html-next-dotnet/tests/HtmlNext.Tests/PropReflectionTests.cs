using AngleSharp.Html.Parser;
using HtmlNext;
using System.Text.Json;
using Xunit;

namespace HtmlNext.Tests;

public sealed class PropReflectionTests
{
    private const string Card = """
        <template component="x-card"><defs>
        <prop name="count" type="integer" default="5">Count.</prop>
        <prop name="pageSize" type="integer" default="10">Size.</prop>
        <prop name="enabled" type="boolean" default="true">Enabled.</prop>
        <prop name="rows" type="list(string)" default="[]">Rows.</prop>
        </defs><article><output>{$count}:{$pageSize}:{$enabled}:{$rows.length}</output></article></template>
        """;
    private const string Source = Card + """
        <template component="x-static"><defs><prop name="count" type="integer" default="5">Count.</prop></defs><x-card from:count="$count"></x-card></template>
        """;

    private static CompiledComponentGraph Graph(string source = Source, bool adopted = false)
    {
        var manifest = ClientAssetTests.Manifest(source);
        if (!adopted)
        {
            manifest["client"]!["adoption"]!.AsArray().Clear();
            manifest["client"]!["creation"]!.AsArray().Clear();
            manifest["client"]!["components"]![0]!["adopt"] = false;
            manifest["client"]!["components"]![0]!["create"] = false;
            manifest["client"]!["components"]![0]!["reasons"]!.AsArray().Clear();
        }
        return HtmlNextCompiler.CompileResource(source, assets: HtmlNextServerAssets.FromManifest(manifest.ToJsonString()));
    }

    public static IEnumerable<object[]> ScalarCases()
    {
        var cases = new[] {
            ("{}", "{}", "5:10:true:0"),
            ("{\"count\":7,\"pageSize\":12}", "{\"count\":\"7\",\"page-size\":\"12\"}", "7:12:true:0"),
            ("{\"count\":null}", "{}", "5:10:true:0"),
            ("{\"enabled\":false}", "{\"enabled\":\"false\"}", "5:10:false:0"),
            ("{\"rows\":[]}", "{\"rows\":\"[]\"}", "5:10:true:0"),
            ("{\"rows\":[\"A\",\"B\"]}", "{\"rows\":\"[\\\"A\\\",\\\"B\\\"]\"}", "5:10:true:2"),
            ("{\"count\":\"wrong\"}", "{\"count\":\"5\"}", "5:10:true:0")
        };
        foreach (var adopted in new[] { false, true }) foreach (var (inputs, metadata, output) in cases)
            yield return [adopted, inputs, metadata, output];
    }

    [Theory]
    [MemberData(nameof(ScalarCases))]
    public void RecordsExplicitAcceptedPropsEvenWhenClientAdoptionIsPruned(bool adopted, string inputs, string metadata, string output)
    {
        using var model = JsonDocument.Parse(inputs);
        var html = Render(Graph(adopted: adopted).Template("x-card"), model.RootElement);
        AssertMetadata(html, "x-card", metadata);
        Assert.Equal(output, new HtmlParser().ParseDocument(html).QuerySelector("output")!.TextContent);
        Assert.Equal(adopted, html.Contains("data-html-next-instance", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("{}", "{}", "{\"count\":\"5\"}")]
    [InlineData("{\"count\":9}", "{\"count\":\"9\"}", "{\"count\":\"9\"}")]
    [InlineData("{\"count\":null}", "{}", "{\"count\":\"5\"}")]
    public void DelegatedRootsKeepEachOwnersExplicitInputs(string inputs, string outer, string inner)
    {
        using var model = JsonDocument.Parse(inputs);
        var html = Render(Graph().Template("x-static"), model.RootElement);
        AssertMetadata(html, "x-static", outer);
        AssertMetadata(html, "x-card", inner);
    }

    [Theory]
    [InlineData(false, "{}", "Authored")]
    [InlineData(false, "{\"count\":null}", "Authored")]
    [InlineData(false, "{\"count\":7}", "7")]
    [InlineData(true, "{}", "5")]
    [InlineData(true, "{\"count\":7}", "7")]
    public void MatchesCurrentSdkOwnershipOfAuthoredMetadata(bool bound, string inputs, string expected)
    {
        var attribute = bound ? "from:data-x-card-prop-count=\"concat('output:', $count)\"" : "data-x-card-prop-count=\"Authored\"";
        var source = Source.Replace("<article>", "<article " + attribute + ">");
        using var model = JsonDocument.Parse(inputs);
        var html = Render(Graph(source).Template("x-card"), model.RootElement);
        var root = new HtmlParser().ParseDocument(html).QuerySelector("article")!;
        Assert.Equal(expected, root.GetAttribute("data-x-card-prop-count"));
        Assert.Equal(1, root.Attributes.Count(attribute => attribute.Name == "data-x-card-prop-count"));
    }

    [Fact]
    public void RefusedNestedBindingsDoNotMakeTheDefaultExplicit()
    {
        var source = Card + """
            <template component="x-static"><defs><state name="text" value="wrong"></state></defs><x-card from:count="$text"></x-card></template>
            """;
        var html = Render(Graph(source, adopted: true).Template("x-static"));
        AssertMetadata(html, "x-card", "{}");
        var record = HydrationRecordTests.Records(html).GetProperty("x-card");
        Assert.DoesNotContain(record.GetProperty("explicit").EnumerateArray(), item => item.GetString() == "count");
    }

    [Fact]
    public void StructuredMetadataKeepsJsonStringsAndReadsApplicationGettersOnce()
    {
        var model = new Model();
        var template = Graph().Template("x-card");
        var html = template.Render(model, options: new() { Interactive = true });
        Assert.Equal(1, model.Reads);
        var root = new HtmlParser().ParseDocument(html).QuerySelector("article")!;
        Assert.Equal("[\"<A>&\\\"\",\"B\\ud800X\"]", root.GetAttribute("data-x-card-prop-rows"));
    }

    [Theory]
    [InlineData("{}", "{}", "3")]
    [InlineData("{\"mode\":\"text\"}", "{\"mode\":\"text\"}", "")]
    [InlineData("{\"mode\":\"text\",\"value\":\"Text\"}", "{\"mode\":\"text\",\"value\":\"Text\"}", "Text")]
    [InlineData("{\"mode\":\"text\",\"value\":\"\"}", "{\"mode\":\"text\",\"value\":\"\"}", "")]
    public void SelectedTypesKeepImplicitDefaultsSeparateFromExplicitValues(string inputs, string metadata, string output)
    {
        const string source = """
            <template component="x-card"><defs>
            <type name="input-value" from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type>
            <prop name="value" type="input-value" default="3">Value.</prop>
            <prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop>
            </defs><article><output>{$value}</output></article></template><template component="x-static"><p>Static</p></template>
            """;
        using var model = JsonDocument.Parse(inputs);
        var html = Render(Graph(source).Template("x-card"), model.RootElement);
        AssertMetadata(html, "x-card", metadata);
        Assert.Equal(output, new HtmlParser().ParseDocument(html).QuerySelector("output")!.TextContent);
    }

    [Fact]
    public async Task RecordingCachesStayLocalToEachRequest()
    {
        var template = Graph().Template("x-card");
        await Task.WhenAll(Enumerable.Range(0, 16).Select(index => Task.Run(() =>
        {
            var html = Render(template, new { count = index });
            AssertMetadata(html, "x-card", "{\"count\":\"" + index + "\"}");
        })));
        AssertMetadata(Render(template), "x-card", "{}");
    }

    [Fact]
    public void StructuredMetadataDuplicatesAliasesAndUsesJsonKeyOrdering()
    {
        const string source = "<template component=\"x-card\"><defs><prop name=\"data\" type=\"object\" open>Data.</prop></defs><article>Data</article></template><template component=\"x-static\"><p>Static</p></template>";
        var shared = new Dictionary<string, object?> { ["value"] = -0.0 };
        var data = new Dictionary<string, object?> { ["right"] = shared, ["10"] = "Ten", ["2"] = "Two", ["left"] = shared };
        var html = Render(Graph(source).Template("x-card"), new { data });
        var root = new HtmlParser().ParseDocument(html).QuerySelector("article")!;
        Assert.Equal("{\"2\":\"Two\",\"10\":\"Ten\",\"right\":{\"value\":0},\"left\":{\"value\":0}}", root.GetAttribute("data-x-card-prop-data"));
    }

    [Fact]
    public void PrunedRootsRejectCyclicMetadata()
    {
        const string source = "<template component=\"x-card\"><defs><prop name=\"data\" type=\"object\" open>Data.</prop></defs><article>Data</article></template><template component=\"x-static\"><p>Static</p></template>";
        var data = new Dictionary<string, object?>();
        data["self"] = data;
        var template = Graph(source).Template("x-card");
        var error = Assert.Throws<HtmlNextException>(() => template.Render(new { data }, options: new() { Interactive = true }));
        Assert.Equal("HNCS008", error.Code);
    }

    [Fact]
    public void StructuredMetadataOmitsUndefinedFieldsAndUsesNullForUndefinedListItems()
    {
        const string source = "<template component=\"x-card\"><defs><prop name=\"data\" type=\"object\" open>Data.</prop></defs><article>Data</article></template><template component=\"x-static\"><p>Static</p></template>";
        var data = new { omit = HtmlNextPreparedRead.UndefinedInput, items = new object?[] { HtmlNextPreparedRead.UndefinedInput, 3 }, keep = (object?)null };
        var html = Render(Graph(source).Template("x-card"), new { data });
        var root = new HtmlParser().ParseDocument(html).QuerySelector("article")!;
        Assert.Equal("{\"items\":[null,3],\"keep\":null}", root.GetAttribute("data-x-card-prop-data"));
    }

    private sealed class Model
    {
        public int Reads;
        public string[] rows { get { Reads++; return ["<A>&\"", "B\ud800X"]; } }
    }

    private static string Render(CompiledTemplate template, object? inputs = null)
    {
        var options = new HtmlNextRenderOptions { Interactive = true };
        var html = template.Render(inputs, options: options);
        using var writer = new StringWriter(); template.Write(writer, inputs, options: options);
        Assert.Equal(html, writer.ToString());
        return html;
    }

    private static void AssertMetadata(string html, string tag, string expected)
    {
        using var document = JsonDocument.Parse(expected);
        var prefix = "data-" + tag + "-prop-";
        var root = new HtmlParser().ParseDocument(html).QuerySelector("article")!;
        var actual = root.Attributes.Where(attribute => attribute.Name.StartsWith(prefix, StringComparison.Ordinal))
            .ToDictionary(attribute => attribute.Name[prefix.Length..], attribute => attribute.Value);
        Assert.Equal(document.RootElement.EnumerateObject().ToDictionary(item => item.Name, item => item.Value.GetString()!).OrderBy(item => item.Key), actual.OrderBy(item => item.Key));
    }
}
