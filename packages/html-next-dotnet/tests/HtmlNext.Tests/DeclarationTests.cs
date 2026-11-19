using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class DeclarationTests
{
    private static CompiledTemplate Compile(string declarations, string body) => HtmlNextCompiler.Compile(
        "<template component=\"x-declarations\"><defs>" + declarations + "</defs>" + body + "</template>", "declarations.html");

    [Fact]
    public void InitializesLiteralStateAndForwardComputedDependenciesOncePerRequest()
    {
        var template = Compile("""
            <computed name="message" from="concat($label, ':', $total)"></computed>
            <state name="offset" type="number" value="2"></state>
            <prop name="amount" type="number">Amount.</prop>
            <computed name="total" from="$amount + $offset"></computed>
            <prop name="label" type="string" default="Total">Label.</prop>
            """, "<output>{$message}:{$total}</output>");
        Assert.Equal("<output>Total:5:5</output>", template.Render(new { amount = 3 }));
        Assert.Equal("<output>Next:9:9</output>", template.Render(new { amount = 7, label = "Next" }));
        using var writer = new StringWriter(); template.Write(writer, new { amount = 3 });
        Assert.Equal("<output>Total:5:5</output>", writer.ToString());
    }

    [Fact]
    public void UntypedStateKeepsWrittenTextAndInvalidComputedResultsStayNull()
    {
        var template = Compile("""
            <state name="text" value="1"></state><state name="empty"></state><state name="step" type="number" value="0"></state>
            <computed name="invalid" from="$text + 2"></computed>
            <computed name="zeroStep" from="round(1, $step)"></computed>
            """, "<output>{$text}:{$invalid}:{$zeroStep}:{default($empty, 'empty')}</output>");
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<output>1:::empty</output>", template.Render(onDiagnostic: diagnostics.Add));
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NonFiniteComputedAndDirectResultsRemainNull()
    {
        var template = Compile("""
            <prop name="divisor" type="number" default="0">Divisor.</prop>
            <computed name="result" from="1 / $divisor"></computed>
            """, "<output>{$result}:{1 / $divisor}:{default(1 / $divisor, 7)}</output>");
        Assert.Equal("<output>::</output>", template.Render());
        Assert.Equal("<output>0.5:0.5:0.5</output>", template.Render(new { divisor = 2 }));
        Assert.Equal("<output>::</output>", template.Render());
    }

    [Fact]
    public void InfersStructuredComputedTypesForListsAndAliases()
    {
        var template = Compile("""
            <computed name="rows" from="$payload.rows"></computed>
            <computed name="payload" from="{ rows: [{ name: $name, id: 1 }, { id: 2, name: 'B' }] }"></computed>
            <prop name="name" type="string">Name.</prop>
            <state name="settings" type="object({ prefix: string })" value="{ prefix: '&lt;' }"></state>
            """, "<div><b $each=\"row of $rows\">{$settings.prefix}{$row.name}:{$row.id}</b></div>");
        Assert.Equal("<div><b>&lt;A:1</b><b>&lt;B:2</b></div>", template.Render(new { name = "A" }));
    }

    [Fact]
    public async Task NestedInstancesAndConcurrentRequestsHaveIndependentInitializedValues()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-child"><defs><state name="offset" type="number" value="2"></state><computed name="total" from="$value + $offset"></computed><prop name="value" type="number">Value.</prop></defs><b>{$total}</b></template>
            <template component="x-parent"><defs><prop name="value" type="number">Value.</prop></defs><div><x-child from:value="$value"></x-child><x-child value="5"></x-child></div></template>
            """);
        var parent = graph.Template("x-parent");
        await Task.WhenAll(Enumerable.Range(0, 32).Select(value => Task.Run(() =>
            Assert.Equal("<div><b>" + (value + 2) + "</b><b>7</b></div>", parent.Render(new { value })))));
    }

    [Fact]
    public void ReportsAnActualComputedCycleWhenRead()
    {
        var template = Compile("<computed name=\"first\" from=\"$second\"></computed><computed name=\"second\" from=\"$first\"></computed>", "<output>{$first}</output>");
        var error = Assert.Throws<HtmlNextException>(() => template.Render());
        Assert.Equal("declarations.html", error.SourceName);
        Assert.Contains("cycle", error.Detail);
    }

    [Theory]
    [InlineData("<state name=\"same\" value=\"1\"></state><prop name=\"same\">Name.</prop>")]
    [InlineData("<state name=\"same\"></state><computed name=\"same\" from=\"1\"></computed>")]
    [InlineData("<computed name=\"missing\" from=\"$undeclared\"></computed>")]
    [InlineData("<computed name=\"missing\"></computed>")]
    [InlineData("<state name=\"wrong\" type=\"number\" value=\"oops\"></state>")]
    [InlineData("<state name=\"wrong\" type=\"number\" from:value=\"1\"></state>")]
    public void RejectsInvalidDeclarationsBeforeRendering(string declarations)
    {
        var error = Assert.Throws<HtmlNextException>(() => Compile(declarations, "<p>Text</p>"));
        Assert.Equal("declarations.html", error.SourceName);
    }
}
