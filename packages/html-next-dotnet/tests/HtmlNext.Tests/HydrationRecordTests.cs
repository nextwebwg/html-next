using System.Text.Json;
using AngleSharp.Html.Parser;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class HydrationRecordTests
{
    internal const string Source = """
        <template component="x-card"><defs>
        <prop name="title" type="string" default="Default">Title.</prop>
        <prop name="count" type="number" default="1">Count.</prop>
        <state name="draft" type="string" from="$title"></state>
        <state name="waiting" from="$unavailable"></state>
        <computed name="unavailable" from="$missing.field"></computed>
        <state name="missing"></state>
        </defs><article><input value="Original"><b>{$draft}</b><output>{$count}</output></article></template>
        <template component="x-static"><p>Static</p></template>
        """;

    private static CompiledComponentGraph Graph(string source = Source) => HtmlNextCompiler.CompileResource(source,
        assets: HtmlNextServerAssets.FromManifest(ClientAssetTests.Manifest(source).ToJsonString()));

    [Fact]
    public void WritesAcceptedPropsCallerOwnershipAndStateThroughTheExistingWireFormat()
    {
        var template = Graph().Template("x-card");
        var html = template.Render(new { title = (string?)null, count = -0d }, options: new() { Interactive = true });
        var record = Records(html).GetProperty("x-card");
        Assert.DoesNotContain(record.GetProperty("explicit").EnumerateArray(), item => item.GetString() == "title");
        Assert.Equal("Default", record.GetProperty("props").GetProperty("title").GetString());
        var input = record.GetProperty("inputs").GetProperty("title");
        Assert.True(input.GetProperty("present").GetBoolean());
        Assert.True(input.GetProperty("provided").GetBoolean());
        Assert.Equal(JsonValueKind.Null, input.GetProperty("value").ValueKind);
        Assert.Equal("Default", record.GetProperty("state").GetProperty("draft").GetString());
        Assert.Equal(new[] { "draft" }, record.GetProperty("initialized").EnumerateArray().Select(item => item.GetString()));
        Assert.Equal(JsonValueKind.Null, record.GetProperty("state").GetProperty("waiting").ValueKind);
        Assert.Contains("negative-zero", html);
        Assert.Null(new HtmlParser().ParseDocument(template.Render()).QuerySelector("[data-html-next-instance]"));
    }

    [Fact]
    public void StreamsTheSameRecordsAndSnapshotsApplicationGettersOnce()
    {
        var template = Graph().Template("x-card");
        var model = new Model();
        var html = template.Render(model, options: new() { Interactive = true });
        Assert.Equal(1, model.Reads);
        using var writer = new StringWriter();
        template.Write(writer, new { title = "<Title>&\"" }, options: new() { Interactive = true });
        Assert.Equal(html, writer.ToString());
        Assert.Equal("<Title>&\"", Records(html).GetProperty("x-card").GetProperty("props").GetProperty("title").GetString());
    }

    [Fact]
    public void LeavesCompilerPrunedStaticRootsWithoutInstanceRecords()
    {
        var html = Graph().Template("x-static").Render(options: new() { Interactive = true });
        Assert.Equal("<p component=\"x-static\">Static</p>", html);
    }

    [Fact]
    public void KeepsRawDefaultsInRecordsWhileReferencesUseTheCurrentSelectedType()
    {
        var source = """
            <template component="x-card"><defs>
            <type name="input-value" from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type>
            <prop name="value" type="input-value" default="3">Value.</prop>
            <prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop>
            </defs><article><output>{$value}</output></article></template>
            <template component="x-static"><p>Static</p></template>
            """;
        var html = Graph(source).Template("x-card").Render(new { mode = "text" }, options: new() { Interactive = true });
        Assert.Equal("", new HtmlParser().ParseDocument(html).QuerySelector("output")!.TextContent);
        var record = Records(html).GetProperty("x-card");
        Assert.Equal(3, record.GetProperty("props").GetProperty("value").GetDouble());
        Assert.False(record.GetProperty("inputs").GetProperty("value").GetProperty("present").GetBoolean());
    }

    [Fact]
    public void ReadsNestedApplicationDataOnceAndWrapsGetterFailuresAtTheBindingBoundary()
    {
        var source = Source.Replace("<prop name=\"title\"", "<prop name=\"payload\" type=\"object({ name: string })\">Payload.</prop><prop name=\"title\"");
        var template = Graph(source).Template("x-card");
        var payload = new Payload();
        var record = Records(template.Render(new { payload }, options: new() { Interactive = true })).GetProperty("x-card");
        Assert.Equal("Nested", record.GetProperty("props").GetProperty("payload").GetProperty("name").GetString());
        Assert.Equal(1, payload.ReadCount());
        var error = Assert.Throws<HtmlNextException>(() => template.Render(new { payload = new ThrowingPayload() }, options: new() { Interactive = true }));
        Assert.Equal("HNCS002", error.Code);
        Assert.IsType<InvalidOperationException>(error.InnerException);
    }

    [Fact]
    public void RejectsCyclicHydrationValuesWhileKeepingInertRenderingAvailable()
    {
        var source = Source.Replace("<prop name=\"title\"", "<prop name=\"payload\" type=\"object\" open>Payload.</prop><prop name=\"title\"");
        var template = Graph(source).Template("x-card");
        var payload = new Dictionary<string, object?>(); payload.Add("self", payload);
        Assert.Contains("<article", template.Render(new { payload }));
        Assert.Equal("HNCS008", Assert.Throws<HtmlNextException>(() => template.Render(new { payload }, options: new() { Interactive = true })).Code);
    }

    [Fact]
    public void PreservesUnpairedUtf16CodeUnitsInTheJsonStringFormat()
    {
        var html = Graph().Template("x-card").Render(new { title = "\ud800X" }, options: new() { Interactive = true });
        var attribute = new HtmlParser().ParseDocument(html).QuerySelector("article")!.GetAttribute("data-html-next-instance")!;
        Assert.Contains("\\ud800", attribute, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("\\uFFFD", attribute, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReusesAnInteractivePlanAcrossIndependentRequests()
    {
        var template = Graph().Template("x-card");
        await Task.WhenAll(Enumerable.Range(0, 16).Select(index => Task.Run(() =>
        {
            var title = index.ToString();
            var record = Records(template.Render(new { title }, options: new() { Interactive = true })).GetProperty("x-card");
            Assert.Equal(title, record.GetProperty("props").GetProperty("title").GetString());
            Assert.Equal(title, record.GetProperty("state").GetProperty("draft").GetString());
        })));
    }

    [Theory]
    [InlineData("none")]
    [InlineData("inert-build")]
    [InlineData("missing-plan")]
    public void RejectsInteractiveRenderingBeforeWritingWhenMatchingClientAssetsAreUnavailable(string defect)
    {
        var manifest = ClientAssetTests.Manifest(Source);
        if (defect == "inert-build") manifest["server"]!["hydrate"] = false;
        if (defect == "missing-plan") manifest.Remove("client");
        var template = HtmlNextCompiler.CompileResource(Source, assets: defect == "none" ? null : HtmlNextServerAssets.FromManifest(manifest.ToJsonString())).Template("x-card");
        using var writer = new StringWriter();
        Assert.Equal("HNCS006", Assert.Throws<HtmlNextException>(() => template.Write(writer, options: new() { Interactive = true })).Code);
        Assert.Equal("", writer.ToString());
    }

    internal static JsonElement Records(string html)
    {
        var element = new HtmlParser().ParseDocument(html).QuerySelector("[data-html-next-instance]")!;
        using var document = JsonDocument.Parse(element.GetAttribute("data-html-next-instance")!);
        Assert.Equal(1, document.RootElement[0].GetInt32());
        // Decode the public tagged format independently of the native writer.
        var references = new List<object>();
        object? Decode(JsonElement node)
        {
            var kind = node[0].GetString();
            if (kind == "value") return node[1].Deserialize<object>();
            if (kind is "absent" or "nonconforming" or "undefined") return null;
            if (kind == "negative-zero") return -0d;
            if (kind == "reference") return references[node[1].GetInt32()];
            if (kind == "json") { var value = node[1].Clone(); references.Add(value); return value; }
            if (kind == "array")
            {
                var array = new List<object?>(); references.Add(array);
                foreach (var item in node[1].EnumerateArray()) array.Add(Decode(item));
                return array;
            }
            Assert.Equal("object", kind);
            var result = new Dictionary<string, object?>(); references.Add(result);
            foreach (var item in node[1].EnumerateArray()) result.Add(item[0].GetString()!, Decode(item[1]));
            return result;
        }
        return JsonSerializer.SerializeToElement(Decode(document.RootElement[1]));
    }

    private sealed class Model
    {
        public int Reads { get; private set; }
        public string title { get { Reads++; return "<Title>&\""; } }
    }
    private sealed class Payload
    {
        private int reads;
        public int ReadCount() => reads;
        public string name { get { reads++; return "Nested"; } }
    }
    private sealed class ThrowingPayload
    {
        public string name => throw new InvalidOperationException("Application getter failed.");
    }
}
