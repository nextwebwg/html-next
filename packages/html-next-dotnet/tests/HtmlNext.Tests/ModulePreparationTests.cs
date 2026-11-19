using AngleSharp.Html.Parser;
using HtmlNext;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ModulePreparationTests
{
    private const string Source = """
        <template component="x-card" module="./producer.js"><defs><prop name="count" type="integer" default="2">Count.</prop><prop name="rows" type="list(string)" required>Rows.</prop><state name="draft" type="list(string)" from="$rows"></state></defs><ol><li $each="row of $draft">{$row}</li></ol></template>
        """;

    private static HtmlNextPreparedModule Prepared(int count) => new("revision", new Dictionary<string, HtmlNextPreparedRead>
    {
        ["rows"] = new(new { count }, Enumerable.Range(0, count).Select(index => "Row " + index).ToArray())
    });

    private static CompiledTemplate Interactive()
    {
        var source = Source + "<template component=\"x-static\"><p>Static</p></template>";
        var manifest = ClientAssetTests.Manifest(source);
        manifest["server"]!["preparedModules"] = new JsonArray(new JsonObject { ["tag"] = "x-card", ["source"] = "revision" });
        return HtmlNextCompiler.CompileResource(source, assets: HtmlNextServerAssets.FromManifest(manifest.ToJsonString())).Template("x-card");
    }

    [Theory]
    [InlineData("shared", "[\"object\",[[\"2\",[\"json\",{\"label\":\"Same\"}]],[\"10\",[\"reference\",1]],[\"text\",[\"negative-zero\"]]]]")]
    [InlineData("unicode", "[\"value\",\"\\ud800a\\udc00\"]")]
    [InlineData("numbers", "[\"array\",[[\"value\",1e-7],[\"value\",100000000000000000000],[\"negative-zero\"]]]")]
    [InlineData("undefined", "[\"undefined\"]")]
    public void WritesCanonicalJavaScriptInputKeysThroughTheRealTransferBoundary(string kind, string expected)
    {
        var shared = new Dictionary<string, object?> { ["label"] = "Same" };
        object input = kind switch
        {
            "shared" => new Dictionary<string, object?> { ["10"] = shared, ["2"] = shared, ["text"] = -0d },
            "unicode" => "\ud800a\udc00",
            "undefined" => HtmlNextPreparedRead.UndefinedInput,
            _ => new[] { 1e-7, 1e20, -0d }
        };
        var options = new HtmlNextRenderOptions { Interactive = true, PrepareModule = context =>
        {
            Assert.Equal("revision", context.Source);
            return new("revision", new Dictionary<string, HtmlNextPreparedRead> { ["rows"] = new(input, new[] { "Row" }) });
        } };
        var template = Interactive();
        var html = template.Render(options: options);
        using var writer = new StringWriter(); template.Write(writer, options: options);
        Assert.Equal(html, writer.ToString());
        using var document = new HtmlParser().ParseDocument(html);
        using var records = JsonDocument.Parse(document.QuerySelector("ol")!.GetAttribute("data-html-next-bindings")!);
        var frame = records.RootElement.GetProperty("x-card");
        Assert.Equal(1, frame[0].GetInt32());
        Assert.Equal("revision", frame[1].GetString());
        Assert.Equal("json", frame[2][0].GetString());
        var read = frame[2][1].GetProperty("snapshot").GetProperty("reads").GetProperty("rows");
        Assert.Equal(expected, read.GetProperty("input").GetString());
        Assert.Equal(expected, read.GetProperty("value").GetString());
    }

    [Fact]
    public void RejectsMismatchedPreparationBeforeWritingInteractiveOutput()
    {
        var template = Interactive();
        using var writer = new StringWriter();
        var options = new HtmlNextRenderOptions { Interactive = true, PrepareModule = _ => new("other-revision", Prepared(1).Reads) };
        Assert.Equal("HNCS006", Assert.Throws<HtmlNextException>(() => template.Write(writer, options: options)).Code);
        Assert.Empty(writer.ToString());
    }

    [Fact]
    public void InvalidProducedValuesDoNotReplaceThePropOrRecordACompletedRead()
    {
        var template = Interactive();
        var diagnostics = new List<HtmlNextDiagnostic>();
        var options = new HtmlNextRenderOptions { Interactive = true, PrepareModule = _ => new("revision",
            new Dictionary<string, HtmlNextPreparedRead> { ["rows"] = new(2, 27) }) };
        var html = template.Render(onDiagnostic: diagnostics.Add, options: options);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Code == "HNCS004");
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Null(document.QuerySelector("[data-html-next-bindings]"));
        Assert.Empty(document.QuerySelectorAll("li"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CallerInputsKeepControlIncludingExplicitNull(bool nullInput)
    {
        var template = HtmlNextCompiler.CompileResource(Source).Template("x-card");
        var options = new HtmlNextRenderOptions { PrepareModule = context =>
        {
            Assert.True(context.Supplied("rows"));
            return Prepared(2);
        } };
        var html = template.Render(new { rows = nullInput ? null : new[] { "Caller" } }, options: options);
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal(nullInput ? Array.Empty<string>() : ["Caller"], document.QuerySelectorAll("li").Select(item => item.TextContent));
    }

    [Fact]
    public void PreparesNestedInvocationsOnceBeforeTheirOwnStateSeeds()
    {
        var template = HtmlNextCompiler.CompileResource(Source + """
            <template component="x-page"><div><x-card count="1"></x-card><x-card count="3"></x-card><x-card rows='["Caller"]'></x-card></div></template>
            """).Template("x-page");
        var calls = 0;
        var options = new HtmlNextRenderOptions { PrepareModule = context =>
        {
            calls++;
            return Prepared((int)(double)context.Props["count"]!);
        } };
        var html = template.Render(options: options);
        Assert.Equal(3, calls);
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal(new[] { 1, 3, 1 }, document.QuerySelectorAll("ol").Select(item => item.QuerySelectorAll("li").Length));
        Assert.Equal("Caller", document.QuerySelectorAll("ol")[2].TextContent);
    }

    [Theory]
    [InlineData("cycle")]
    [InlineData("nonfinite")]
    [InlineData("delegate")]
    [InlineData("guid")]
    [InlineData("non-string-keys")]
    public void RejectsNonTransferableReadIdentitiesWithoutPoisoningThePlan(string kind)
    {
        var template = HtmlNextCompiler.CompileResource(Source).Template("x-card");
        var cycle = new Dictionary<string, object?>(); cycle["self"] = cycle;
        object input = kind switch { "cycle" => cycle, "nonfinite" => double.PositiveInfinity, "delegate" => (Action)(() => { }),
            "non-string-keys" => new Dictionary<int, string> { [1] = "Row" }, _ => Guid.NewGuid() };
        var options = new HtmlNextRenderOptions { PrepareModule = _ => new("revision", new Dictionary<string, HtmlNextPreparedRead> { ["rows"] = new(input, new[] { "Row" }) }) };
        Assert.Equal("HNCS008", Assert.Throws<HtmlNextException>(() => template.Render(options: options)).Code);
        using var document = new HtmlParser().ParseDocument(template.Render(options: new() { PrepareModule = _ => Prepared(1) }));
        Assert.Equal("Row 0", document.QuerySelector("li")!.TextContent);
    }

    [Fact]
    public void ObservesCancellationAfterTheApplicationCallback()
    {
        var template = HtmlNextCompiler.CompileResource(Source).Template("x-card");
        using var cancellation = new CancellationTokenSource();
        var options = new HtmlNextRenderOptions { PrepareModule = context =>
        {
            Assert.Equal(cancellation.Token, context.CancellationToken);
            cancellation.Cancel();
            return Prepared(1);
        } };
        using var writer = new StringWriter();
        Assert.Throws<OperationCanceledException>(() => template.Write(writer, cancellationToken: cancellation.Token, options: options));
        Assert.Empty(writer.ToString());
    }

    [Fact]
    public void JsonNullProducedValuesTakeTheDeclaredDefault()
    {
        var source = Source.Replace("type=\"list(string)\" required", "type=\"list(string)\" default=\"[]\"", StringComparison.Ordinal);
        var template = HtmlNextCompiler.CompileResource(source).Template("x-card");
        var diagnostics = new List<HtmlNextDiagnostic>();
        template.Render(onDiagnostic: diagnostics.Add, options: new() { PrepareModule = _ => new("revision",
            new Dictionary<string, HtmlNextPreparedRead> { ["rows"] = new(null, JsonSerializer.SerializeToElement<object?>(null)) }) });
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "HNCS004");
    }

    [Fact]
    public void PreparationInputGetterErrorsKeepTheirSourceAndInnerFailure()
    {
        var template = HtmlNextCompiler.CompileResource(Source, "prepared.html").Template("x-card");
        var error = Assert.Throws<HtmlNextException>(() => template.Render(options: new()
        {
            PrepareModule = _ => new("revision", new Dictionary<string, HtmlNextPreparedRead> { ["rows"] = new(new ThrowingInput(), new[] { "Row" }) })
        }));
        Assert.Equal("HNCS002", error.Code);
        Assert.Equal("prepared.html", error.SourceName);
        Assert.IsType<InvalidOperationException>(error.InnerException);
    }

    private sealed class ThrowingInput
    {
        public string Value => throw new InvalidOperationException("Input failed.");
    }

    [Fact]
    public void KeepsAStateAlreadySeededFromAnAvailableDefault()
    {
        var source = Source.Replace("type=\"list(string)\" required", "type=\"list(string)\" default=\"[]\"", StringComparison.Ordinal);
        var template = HtmlNextCompiler.CompileResource(source).Template("x-card");
        var html = template.Render(options: new() { PrepareModule = _ => Prepared(2) });
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Empty(document.QuerySelectorAll("li"));
    }

    [Fact]
    public void AppliesSettledResultsBeforeStateInitializationWithoutMissingInputWarnings()
    {
        var template = HtmlNextCompiler.CompileResource(Source).Template("x-card");
        var diagnostics = new List<HtmlNextDiagnostic>();
        var calls = 0;
        var options = new HtmlNextRenderOptions { PrepareModule = context =>
        {
            calls++;
            Assert.Equal("x-card", context.Module.Component);
            Assert.Equal("./producer.js", context.Module.Specifier);
            Assert.Equal(2d, context.Props["count"]);
            Assert.False(context.Supplied("rows"));
            return Prepared(2);
        } };
        var html = template.Render(onDiagnostic: diagnostics.Add, options: options);
        Assert.Equal(1, calls);
        Assert.Empty(diagnostics);
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal(new[] { "Row 0", "Row 1" }, document.QuerySelectorAll("li").Select(item => item.TextContent));
    }

    [Fact]
    public async Task ReusesPlansWithoutSharingPreparedRequestsOrRepeatingBufferedReads()
    {
        var template = HtmlNextCompiler.CompileResource(Source).Template("x-card");
        var calls = 0;
        var options = new HtmlNextRenderOptions { PrepareModule = context =>
        {
            Interlocked.Increment(ref calls);
            return Prepared((int)(double)context.Props["count"]!);
        } };
        await Task.WhenAll(Enumerable.Range(1, 16).Select(count => Task.Run(() =>
        {
            var html = template.Render(new { count }, options: options);
            using var writer = new StringWriter(); template.Write(writer, new { count }, options: options);
            Assert.Equal(html, writer.ToString());
            using var document = new HtmlParser().ParseDocument(html);
            Assert.Equal(count, document.QuerySelectorAll("li").Length);
        })));
        Assert.Equal(32, calls);
    }
}
