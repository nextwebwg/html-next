using System.Globalization;
using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class RenderingTests
{
    private const string Card = """
        <template component="x-card"><defs>
        <prop name="title" type="string" required>Input value.</prop>
        <prop name="visible" type="boolean" default="true">Input value.</prop>
        </defs><article from:title="$title"><h2 $if="$visible">{$title}</h2></article></template>
        """;

    [Fact]
    public void ReusesTheCompiledTemplateWithPocoAndDictionaryInputs()
    {
        var template = HtmlNextCompiler.Compile(Card, "card.html");
        Assert.Equal("<article title=\"first\"><h2>first</h2></article>", template.Render(new CardInput("first")));
        Assert.Equal("<article title=\"second\"></article>", template.Render(new Dictionary<string, object?>
        {
            ["title"] = "second", ["visible"] = false
        }));
        Assert.Equal("x-card", template.Tag);
    }

    [Fact]
    public void ReadsStructPropertiesAndJsonValuesWithTheSameBindingNames()
    {
        var template = HtmlNextCompiler.Compile(Card);
        Assert.Equal(template.Render(new CardInput("value")), template.Render(new StructInput("value")));
        using var json = JsonDocument.Parse("{\"title\":\"value\",\"visible\":false}");
        Assert.Equal("<article title=\"value\"></article>", template.Render(json.RootElement));
    }

    [Fact]
    public async Task ConcurrentRequestsNeverShareTheirInputSlots()
    {
        var template = HtmlNextCompiler.Compile(Card);
        var outputs = await Task.WhenAll(Enumerable.Range(0, 100).Select(index => Task.Run(() =>
            template.Render(new CardInput(index.ToString(CultureInfo.InvariantCulture))))));
        for (var index = 0; index < outputs.Length; index++)
            Assert.Equal($"<article title=\"{index}\"><h2>{index}</h2></article>", outputs[index]);
    }

    [Fact]
    public void EscapesDynamicTextAndAttributesWithoutTreatingValuesAsMarkup()
    {
        var template = HtmlNextCompiler.Compile(Card);
        var output = template.Render(new CardInput("<b>&\"'"));
        Assert.Equal("<article title=\"&lt;b&gt;&amp;&quot;'\"><h2>&lt;b&gt;&amp;\"'</h2></article>", output);
    }

    [Fact]
    public void SizesUnicodeAndEscapedOutputWithoutReadingGettersTwice()
    {
        var template = HtmlNextCompiler.Compile(Card);
        var input = new CountingInput();
        Assert.Equal("<article title=\"Résumé 👋 &amp; &lt;value&gt;\"><h2>Résumé 👋 &amp; &lt;value&gt;</h2></article>", template.Render(input));
        Assert.Equal(1, input.Reads);
    }

    [Theory]
    [InlineData(-0.0, "0")]
    [InlineData(0.5, "0.5")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(1e-6, "0.000001")]
    [InlineData(-1.23e-6, "-0.00000123")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(1e21, "1e+21")]
    [InlineData(double.MaxValue, "1.7976931348623157e+308")]
    public void WritesNumbersConsistentlyToStringsAndWriters(double value, string expected)
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-number"><defs><prop name="value" type="number" required>Number.</prop></defs><output>{$value}</output></template>
            """);
        using var writer = new StringWriter(CultureInfo.InvariantCulture);
        template.Write(writer, new { value });
        Assert.Equal("<output>" + expected + "</output>", template.Render(new { value }));
        Assert.Equal(template.Render(new { value }), writer.ToString());
    }

    [Fact]
    public void NormalizesJsonArraysAndKeepsNestedDiagnosticPaths()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-numbers"><defs><prop name="items" type="list(number)" required>Numbers.</prop></defs><output><b $each="item of $items">{$item}</b></output></template>
            """);
        using var json = JsonDocument.Parse("{\"items\":[0.5,1e21]}");
        Assert.Equal("<output><b>0.5</b><b>1e+21</b></output>", template.Render(json.RootElement));
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<output></output>", template.Render(new { items = new object[] { "wrong" } }, onDiagnostic: diagnostics.Add));
        Assert.Contains("items[]", Assert.Single(diagnostics).Message);
    }

    [Fact]
    public void BindsNestedObjectsAndNestedLoopLocals()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-list"><defs>
            <prop name="groups" type="list(object({title: string, items: list(string)}))" required>Input value.</prop>
            </defs><section><article $each="group of $groups"><h2>{$group.title}</h2><ul><li $each="item of $group.items">{$item}</li></ul></article></section></template>
            """);
        var groups = new[] { new GroupInput("A", ["one", "<two>"]), new GroupInput("B", []) };
        Assert.Equal("<section><article><h2>A</h2><ul><li>one</li><li>&lt;two&gt;</li></ul></article><article><h2>B</h2><ul></ul></article></section>",
            template.Render(new { groups }));
    }

    [Fact]
    public void EnumeratesOneShotInputsOncePerRender()
    {
        var enumerations = 0;
        IEnumerable<string> Items()
        {
            Assert.Equal(1, ++enumerations);
            yield return "one";
            yield return "two";
        }
        var template = HtmlNextCompiler.Compile("""
            <template component="x-list"><defs><prop name="items" type="list(string)" required>Input value.</prop></defs><ul><li $each="item of $items">{$item}</li></ul></template>
            """);
        Assert.Equal("<ul><li>one</li><li>two</li></ul>", template.Render(new { items = Items() }));
    }

    [Fact]
    public void WritesTheSameOutputToAWriterAndHonorsCancellation()
    {
        var template = HtmlNextCompiler.Compile(Card);
        using var writer = new StringWriter(CultureInfo.InvariantCulture);
        template.Write(writer, new CardInput("value"));
        Assert.Equal(template.Render(new CardInput("value")), writer.ToString());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => template.Render(new CardInput("value"), cancellation.Token));
    }

    [Fact]
    public void ReportsRequiredAndNonconformingValuesWithTheirSource()
    {
        var template = HtmlNextCompiler.Compile(Card, "card.html");
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<article><h2></h2></article>", template.Render(onDiagnostic: diagnostics.Add));
        var missing = Assert.Single(diagnostics);
        Assert.Equal("card.html", missing.SourceName);
        Assert.Equal("HNCS003", missing.Code);
        Assert.Contains("title", missing.Message);
        diagnostics.Clear();
        Assert.Equal("<article><h2></h2></article>", template.Render(new { title = 42 }, onDiagnostic: diagnostics.Add));
        Assert.Equal("HNCS004", Assert.Single(diagnostics).Code);
        Assert.Equal("<article title=\"ok\"><h2>ok</h2></article>", template.Render(new CardInput("ok")));
    }

    [Fact]
    public void NullInputsResolveDeclaredDefaultsForPocosDictionariesAndJson()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-default"><defs><prop name="label" type="string" default="Fallback">Label.</prop></defs><p from:title="$label">{$label}</p></template>
            """);
        Assert.Equal("<p title=\"Fallback\">Fallback</p>", template.Render());
        Assert.Equal("<p title=\"Fallback\">Fallback</p>", template.Render(new { label = (string?)null }));
        Assert.Equal("<p title=\"Fallback\">Fallback</p>", template.Render(new Dictionary<string, object?> { ["label"] = null }));
        using var json = JsonDocument.Parse("{\"label\":null}");
        Assert.Equal("<p title=\"Fallback\">Fallback</p>", template.Render(json.RootElement));
        Assert.Equal("<p title=\"\"></p>", template.Render(new { label = "" }));
        Assert.Equal("<p title=\"Fallback\">Fallback</p>", template.Render(new { label = 42 }));
    }

    [Fact]
    public void ReportsDataFailuresOnceBeforeOutputAndLeavesCancellationExceptional()
    {
        var template = HtmlNextCompiler.Compile(Card, "card.html");
        var diagnostics = new List<HtmlNextDiagnostic>();
        using var writer = new StringWriter(CultureInfo.InvariantCulture);
        template.Write(writer, new { title = 42 }, onDiagnostic: diagnostics.Add);
        Assert.Equal("<article><h2></h2></article>", writer.ToString());
        Assert.Single(diagnostics);
        diagnostics.Clear();
        Assert.Equal(writer.ToString(), template.Render(new { title = 42 }, onDiagnostic: diagnostics.Add));
        Assert.Single(diagnostics); // The counting pass must not duplicate binding diagnostics.
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => template.Render(onDiagnostic: diagnostics.Add, cancellationToken: cancelled.Token));
    }

    [Fact]
    public void ReportsGetterFailuresAtTheInputBoundary()
    {
        var template = HtmlNextCompiler.Compile(Card, "card.html");
        var error = Assert.Throws<HtmlNextException>(() => template.Render(new ThrowingInput()));
        Assert.Equal("card.html", error.SourceName);
        Assert.IsType<InvalidOperationException>(error.InnerException);
        Assert.Contains("title", error.Message);
    }

    [Fact]
    public void DisposesAnInputEnumeratorWhenBindingIsCancelled()
    {
        using var cancellation = new CancellationTokenSource();
        var disposed = false;
        IEnumerable<string> Items()
        {
            try { yield return "one"; cancellation.Cancel(); yield return "two"; }
            finally { disposed = true; }
        }
        var template = HtmlNextCompiler.Compile("""
            <template component="x-list"><defs><prop name="items" type="list(string)" required>Items.</prop></defs><ul><li $each="item of $items">{$item}</li></ul></template>
            """);
        Assert.Throws<OperationCanceledException>(() => template.Render(new { items = Items() }, cancellation.Token));
        Assert.True(disposed);
        Assert.Equal("<ul><li>after</li></ul>", template.Render(new { items = new[] { "after" } }));
    }

    [Theory]
    [InlineData("$missing")]
    [InlineData("$title + 1")]
    public void RejectsUnimplementedOrUnboundExpressionsDuringCompilation(string expression)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile(Card.Replace("{$title}", "{" + expression + "}")));
    }

    [Fact]
    public void RejectsFeaturesOutsideTheMeasuredSliceInsteadOfSilentlyDroppingThem()
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile(Card.Replace("<article", "<article on:click=\"go\"")));
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile(Card.Replace("</defs>", "</defs><style>h2{color:red}</style>")));
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile(Card.Replace("<h2", "<x-child")));
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("<template component=\"x-select\"><select><slot>content</slot></select></template>"));
    }

    [Fact]
    public void UsesHtmlFragmentParsingForTablesAndForeignContent()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-table"><table><tr><td>A &amp; B</td></tr></table></template>
            """);
        Assert.Equal("<table><tbody><tr><td>A &amp; B</td></tr></tbody></table>", template.Render());
        var svg = HtmlNextCompiler.Compile("""
            <template component="x-icon"><svg viewBox="0 0 1 1"><path d="M0 0"></path></svg></template>
            """);
        Assert.Contains("viewBox=\"0 0 1 1\"", svg.Render());
    }

    public sealed record CardInput(string title);
    public readonly record struct StructInput(string title);
    public sealed class ThrowingInput { public string title => throw new InvalidOperationException("getter failure"); }
    public sealed class CountingInput
    {
        public int Reads { get; private set; }
        public string title { get { Reads++; return "Résumé 👋 & <value>"; } }
    }
    public sealed record GroupInput(string title, string[] items);
}
