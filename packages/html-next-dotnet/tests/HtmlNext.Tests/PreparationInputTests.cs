using HtmlNext;
using System.Text.Json;
using Xunit;

namespace HtmlNext.Tests;

public sealed class PreparationInputTests
{
    private const string Source = """
        <template component="x-read" module="./producer.js"><defs>
        <prop name="count" type="integer" default="2">Count.</prop><prop name="rows" type="list(string)">Rows.</prop>
        <state name="draft" type="integer" from="$count"></state><state name="waiting" from="$rows"></state>
        <computed name="label" from="concat('Count:', $draft)"></computed><computed name="unused" from="$unused"></computed>
        </defs><output>{$label}:{$rows.length}</output></template>
        """;

    [Fact]
    public void ReadsSeededStateAndComputedsLazilyWithoutTouchingAnUnusedCycle()
    {
        var template = HtmlNextCompiler.Compile(Source);
        HtmlNextPreparationContext? retained = null;
        var options = new HtmlNextRenderOptions { PrepareModule = context =>
        {
            retained = context;
            Assert.Equal(new[] { "count", "rows", "draft", "waiting", "label", "unused" }, context.ReadNames);
            Assert.Equal(2d, context.Read("draft").Value);
            Assert.True(context.Read("draft").Ready);
            Assert.Equal("Count:2", context.Read("label").Value);
            Assert.True(context.Read("label").Ready);
            Assert.False(context.Read("waiting").Ready);
            Assert.False(context.Read("rows").Ready);
            Assert.Throws<KeyNotFoundException>(() => context.Read("missing"));
            return new("revision", new Dictionary<string, HtmlNextPreparedRead> { ["rows"] = new(context.Read("draft").Value, new[] { "One", "Two" }) });
        } };
        Assert.Equal("<output>Count:2:2</output>", template.Render(options: options));
        Assert.Throws<InvalidOperationException>(() => retained!.Read("draft"));
    }

    [Theory]
    [InlineData(true, "{}", true, false)]
    [InlineData(true, "{\"count\":null}", true, true)]
    [InlineData(true, "{\"count\":\"wrong\"}", true, true)]
    [InlineData(true, "{\"count\":0}", true, true)]
    [InlineData(false, "{}", false, false)]
    [InlineData(false, "{\"count\":null}", true, true)]
    [InlineData(false, "{\"count\":\"wrong\"}", false, true)]
    [InlineData(false, "{\"count\":0}", true, true)]
    public void ReadsInputAvailabilitySeparatelyFromAcceptedFallbackAndCallerOwnership(bool hasDefault, string json, bool ready, bool supplied)
    {
        var source = "<template component=\"x-read\" module=\"./producer.js\"><defs><prop name=\"count\" type=\"integer\"" + (hasDefault ? " default=\"2\"" : "") + ">Count.</prop></defs><p>{$count}</p></template>";
        using var model = JsonDocument.Parse(json);
        var options = new HtmlNextRenderOptions { PrepareModule = context =>
        {
            Assert.Equal(ready, context.Read("count").Ready);
            Assert.Equal(supplied, context.Supplied("count"));
            Assert.Equal(json.Contains(":0", StringComparison.Ordinal) ? 0d : hasDefault ? 2d : (object?)null, context.Read("count").Value);
            return null;
        } };
        HtmlNextCompiler.Compile(source).Render(model.RootElement, options: options);
    }

    [Fact]
    public void EncodesStructuredReadsThroughTheExistingSdkTransferCodec()
    {
        const string source = "<template component=\"x-read\" module=\"./producer.js\"><defs><prop name=\"data\" type=\"object\" open>Data.</prop></defs><p>Data</p></template>";
        var shared = new Dictionary<string, object?> { ["value"] = -0d };
        var data = new { left = shared, right = shared, missing = HtmlNextPreparedRead.UndefinedInput };
        var options = new HtmlNextRenderOptions { PrepareModule = context =>
        {
            var input = context.Read("data");
            Assert.Same(input, context.Read("data"));
            Assert.Equal("[\"object\",[[\"left\",[\"object\",[[\"value\",[\"negative-zero\"]]]]],[\"right\",[\"reference\",1]],[\"missing\",[\"undefined\"]]]]", input.EncodeValue());
            return null;
        } };
        HtmlNextCompiler.Compile(source).Render(new { data }, options: options);
    }

    [Theory]
    [InlineData("[\"value\",\"A\\ud800B\"]", new[] { 0x41, 0xd800, 0x42 })]
    [InlineData("[\"value\",\"\\\"\\\\\\b\\f\\n\\r\\t/\"]", new[] { 34, 92, 8, 12, 10, 13, 9, 47 })]
    public void ReceivesJavaScriptTransferStringsWithoutReplacingCodeUnits(string encoded, int[] expected)
    {
        var read = HtmlNextPreparedRead.FromTransfer("selected-input-key", encoded);
        Assert.Equal("selected-input-key", read.InputKey);
        Assert.Equal(expected, Assert.IsType<string>(read.Value).Select(character => (int)character));
    }

    [Fact]
    public void ReceivesAliasedValuesUndefinedAndNegativeZeroFromJavaScript()
    {
        var read = HtmlNextPreparedRead.FromTransfer("key", "[\"object\",[[\"left\",[\"json\",{\"\\ud800\":\"Value\"}]],[\"right\",[\"reference\",1]],[\"missing\",[\"undefined\"]],[\"zero\",[\"negative-zero\"]]]]");
        var value = Assert.IsType<Dictionary<string, object?>>(read.Value);
        Assert.Same(value["left"], value["right"]);
        Assert.Equal("Value", Assert.IsType<Dictionary<string, object?>>(value["left"])["\ud800"]);
        Assert.Same(HtmlNextPreparedRead.UndefinedInput, value["missing"]);
        Assert.True(double.IsNegative(Assert.IsType<double>(value["zero"])));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[\"reference\",0]")]
    [InlineData("[\"object\",[[\"name\",[\"value\",1]],[\"name\",[\"value\",2]]]]")]
    [InlineData("[\"value\",{}]")]
    [InlineData("[\"value\",1e999]")]
    [InlineData("[\"array\",[27]]")]
    public void RejectsMalformedJavaScriptPreparedValues(string encoded)
    {
        Assert.Equal("HNCS008", Assert.Throws<HtmlNextException>(() => HtmlNextPreparedRead.FromTransfer("key", encoded)).Code);
    }

    [Fact]
    public void TransferredUndefinedFieldsUseNativeAbsenceFallbacks()
    {
        const string source = "<template component=\"x-read\" module=\"./producer.js\"><defs><prop name=\"data\" type=\"object\" open>Data.</prop></defs><output>{default($data.missing, 'Fallback')}:{$data.present}</output></template>";
        var options = new HtmlNextRenderOptions { PrepareModule = _ => new("revision", new Dictionary<string, HtmlNextPreparedRead> {
            ["data"] = HtmlNextPreparedRead.FromTransfer("key", "[\"object\",[[\"missing\",[\"undefined\"]],[\"present\",[\"value\",\"Here\"]]]]")
        }) };
        Assert.Equal("<output>Fallback:Here</output>", HtmlNextCompiler.Compile(source).Render(options: options));
    }

    [Fact]
    public void TransferredUndefinedPropRestoresItsDefault()
    {
        const string source = "<template component=\"x-read\" module=\"./producer.js\"><defs><prop name=\"label\" type=\"string\" default=\"Default\">Label.</prop></defs><output>{$label}</output></template>";
        var diagnostics = new List<HtmlNextDiagnostic>();
        var options = new HtmlNextRenderOptions { PrepareModule = _ => new("revision", new Dictionary<string, HtmlNextPreparedRead> {
            ["label"] = HtmlNextPreparedRead.FromTransfer("key", "[\"undefined\"]")
        }) };
        Assert.Equal("<output>Default</output>", HtmlNextCompiler.Compile(source).Render(onDiagnostic: diagnostics.Add, options: options));
        Assert.Empty(diagnostics);
    }
}
