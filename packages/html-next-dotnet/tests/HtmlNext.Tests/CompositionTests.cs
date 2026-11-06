using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class CompositionTests
{
    private const string Label = """
        <template component="x-label"><defs><prop name="label" type="string" default="Default">Label.</prop></defs><b>{$label}</b></template>
        """;

    [Fact]
    public void BindsStaticAndDynamicPropsAndResolvesNullThroughChildDefaults()
    {
        var graph = HtmlNextCompiler.CompileResource(Label + """
            <template component="x-page"><defs><prop name="name" type="string">Name.</prop></defs><div><x-label label="&lt;Literal&gt;"></x-label><x-label from:label="$name"></x-label><x-label></x-label><x-label from:label="null"></x-label></div></template>
            """);
        var template = graph.Template("x-page");
        var expected = "<div><b>&lt;Literal&gt;</b><b>A &amp; B</b><b>Default</b><b>Default</b></div>";
        Assert.Equal(expected, template.Render(new { name = "A & B" }));
        using var writer = new StringWriter(); template.Write(writer, new { name = "A & B" });
        Assert.Equal(expected, writer.ToString());
    }

    [Fact]
    public void NonFiniteInvocationResultsKeepChildDefaults()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-number"><defs><prop name="n" type="number" default="5">Number.</prop></defs><b>{$n}</b></template>
            <template component="x-page"><defs><prop name="divisor" type="number" default="0">Divisor.</prop></defs><div><x-number from:n="1 / $divisor"></x-number></div></template>
            """);
        var template = graph.Template("x-page");
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<div><b>5</b></div>", template.Render(onDiagnostic: diagnostics.Add));
        Assert.Empty(diagnostics);
        Assert.Equal("<div><b>0.5</b></div>", template.Render(new { divisor = 2 }));
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal("<div><b>5</b></div>", writer.ToString());
    }

    [Fact]
    public void BindsRepeatedInstancesOnceAndPreservesPerInstanceDataAcrossOutputPasses()
    {
        var graph = HtmlNextCompiler.CompileResource(Label + """
            <template component="x-list"><defs><prop name="rows" type="list(string)">Rows.</prop></defs><ul><x-label $each="row of $rows" from:label="$row"></x-label></ul></template>
            """);
        Assert.Equal("<ul><b>One</b><b>Two</b></ul>", graph.Template("x-list").Render(new { rows = new[] { "One", "Two" } }));
    }

    [Fact]
    public void RemapsStructuredPropLayoutsWithoutCallingApplicationGettersTwice()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-item"><defs><prop name="row" type="object({ id: number, name: string })">Row.</prop></defs><b>{$row.id}:{$row.name}</b></template>
            <template component="x-page"><defs><prop name="row" type="object({ name: string, id: number })">Row.</prop></defs><div><x-item from:row="$row"></x-item></div></template>
            """);
        var row = new CountingRow();
        Assert.Equal("<div><b>2:Ready</b></div>", graph.Template("x-page").Render(new { row }));
        Assert.Equal(2, row.Reads);
    }

    [Fact]
    public void CanonicalizesSeparateObjectPropsBeforeComparingTheirReferences()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-equal"><defs><prop name="left" type="object({ id: number, name: string })">Left.</prop><prop name="right" type="object({ name: string, id: number })">Right.</prop></defs><b>{$left = $left}:{$left = $right}</b></template>
            <template component="x-page"><defs><prop name="row" type="object({ name: string, id: number })">Row.</prop></defs><div><x-equal from:left="$row" from:right="$row"></x-equal><x-equal from:left="$row" from:right="{ name: 'A', id: 1 }"></x-equal></div></template>
            """).Template("x-page");
        Assert.Equal("<div><b>true:false</b><b>true:false</b></div>", template.Render(new { row = new { name = "A", id = 1 } }));
    }

    [Fact]
    public void RendersAdaptedListPropsWithSeparateCanonicalIdentities()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-rows"><defs><prop name="rows" type="list(object({ name: string, id: number }))">Rows.</prop><prop name="same" type="list(object({ id: number, name: string }))">Same rows.</prop></defs><section><b>{$rows = $rows}:{$rows = $same}</b><i $each="row of $rows">{$row.name}:{$row.id}</i></section></template>
            <template component="x-page"><defs><prop name="rows" type="list(object({ id: number, name: string }))">Rows.</prop></defs><div><x-rows from:rows="$rows" from:same="$rows"></x-rows></div></template>
            """).Template("x-page");
        var data = new { rows = new[] { new { id = 1, name = "A" }, new { id = 2, name = "B" } } };
        const string expected = "<div><section><b>true:false</b><i>A:1</i><i>B:2</i></section></div>";
        Assert.Equal(expected, template.Render(data));
        using var writer = new StringWriter(); template.Write(writer, data);
        Assert.Equal(expected, writer.ToString());
    }

    [Fact]
    public void RecursiveComponentCallsUseTheSameCompiledGraphAndFiniteData()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-count"><defs><prop name="n" type="number">Count.</prop></defs><div>{$n}<x-count $if="$n > 0" from:n="$n - 1"></x-count></div></template>
            """);
        Assert.Equal("<div>3<div>2<div>1<div>0</div></div></div></div>", graph.Template("x-count").Render(new { n = 3 }));
    }

    [Fact]
    public void DeepExpansionReportsAPlatformResourceFailureInsteadOfExhaustingTheHostStack()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-count"><defs><prop name="n" type="number">Count.</prop></defs><div><x-count $if="$n > 0" from:n="$n - 1"></x-count></div></template>
            """, "recursive.html").Template("x-count");
        var error = Assert.Throws<HtmlNextException>(() => template.Render(new { n = 100_000 }));
        Assert.Equal("HNCS006", error.Code);
        Assert.Equal("recursive.html", error.SourceName);
        Assert.IsType<InsufficientExecutionStackException>(error.InnerException);
    }

    [Fact]
    public void ChildDataDiagnosticsAreReportedOnceAndRenderingContinues()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-integer"><defs><prop name="n" type="integer" default="2">Count.</prop></defs><b>{$n}</b></template>
            <template component="x-page"><div><x-integer from:n="1.5"></x-integer></div></template>
            """, "children.html");
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<div><b>2</b></div>", graph.Template("x-page").Render(onDiagnostic: diagnostics.Add));
        Assert.Equal("HNCS004", Assert.Single(diagnostics).Code);
        Assert.Equal("children.html", diagnostics[0].SourceName);
    }

    [Fact]
    public async Task CachedNestedPlansKeepConcurrentRequestsIsolated()
    {
        var template = HtmlNextCompiler.CompileResource(Label + """
            <template component="x-page"><defs><prop name="name" type="string">Name.</prop></defs><section><x-label from:label="$name"></x-label></section></template>
            """).Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 32).Select(index => Task.Run(() =>
            Assert.Equal("<section><b>" + index + "</b></section>", template.Render(new { name = index.ToString(System.Globalization.CultureInfo.InvariantCulture) })))));
    }

    [Fact]
    public void PreservesNonAsciiPropCaseAndConvertsWrittenPropsAtCompilation()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-leaf"><defs><prop name="é" type="string">Lower.</prop><prop name="É" type="string">Upper.</prop><prop name="itemCount" type="integer">Count.</prop></defs><b>{$é}:{$É}:{$itemCount}</b></template>
            <template component="x-page"><div><x-leaf é="lower" É="upper" itemCount="3"></x-leaf></div></template>
            """).Template("x-page");
        Assert.Equal("<div><b>lower:upper:3</b></div>", template.Render());
    }

    [Fact]
    public void BindsSerializedDimensionsAtComponentStringBoundaries()
    {
        var template = HtmlNextCompiler.CompileResource(Label + """
            <template component="x-width"><defs><prop name="width" type="length">Width.</prop></defs><b>{$width}</b></template>
            <template component="x-page"><div><x-width from:width="'8px'"></x-width><x-label from:label="1.5rem"></x-label></div></template>
            """).Template("x-page");
        Assert.Equal("<div><b>8px</b><b>1.5rem</b></div>", template.Render());
    }

    [Theory]
    [InlineData("<x-label label=\"one\" from:label=\"'two'\"></x-label>")]
    [InlineData("<x-label from:label=\"1\"></x-label>")]
    [InlineData("<x-label onclick=\"run()\"></x-label>")]
    public void RejectsConflictingInvalidOrUnimplementedInvocationFeatures(string call)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(Label + "<template component=\"x-page\"><div>" + call + "</div></template>"));
    }

    private sealed class CountingRow
    {
        public int Reads;
        public string name { get { Reads++; return "Ready"; } }
        public int id { get { Reads++; return 2; } }
    }
}
