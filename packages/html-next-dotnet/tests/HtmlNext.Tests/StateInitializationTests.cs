using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class StateInitializationTests
{
    private static CompiledTemplate Compile(string declarations, string body = "<output>{$draft}</output>") => HtmlNextCompiler.Compile(
        "<template component=\"x-state-seed\"><defs>" + declarations + "</defs>" + body + "</template>", "state-seed.html");

    [Fact]
    public async Task SeedsForwardDeclarationsPerRequestAndChildInstance()
    {
        var template = Compile("""
            <state name="draft" type="string" from="$label"></state>
            <computed name="label" from="concat($name, '!')"></computed>
            <prop name="name" type="string" default="A">Name.</prop>
            """);
        Assert.Equal("<output>A!</output>", template.Render());
        await Task.WhenAll(Enumerable.Range(0, 32).Select(index => Task.Run(() =>
            Assert.Equal("<output>" + index + "!</output>", template.Render(new { name = index.ToString() })))));
        using var writer = new StringWriter(); template.Write(writer, new { name = "B" });
        Assert.Equal("<output>B!</output>", writer.ToString());

        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-child"><defs><prop name="name" type="string">Name.</prop><state name="draft" type="string" from="$name"></state></defs><b>{$draft}</b></template>
            <template component="x-parent"><div><x-child name="First"></x-child><x-child name="Second"></x-child></div></template>
            """);
        Assert.Equal("<div><b>First</b><b>Second</b></div>", graph.Template("x-parent").Render());
    }

    [Fact]
    public void ReadsOnlyActualBranchesAndCachesDependenciesAcrossOutputPasses()
    {
        var template = Compile("""
            <state name="draft" type="number" from="$choose ? $later : 4"></state>
            <computed name="later" from="$draft + 1"></computed>
            <prop name="choose" type="boolean" default="false">Choose.</prop>
            """, "<output>{$draft}:{$later}</output>");
        Assert.Equal("<output>4:5</output>", template.Render());
        var error = Assert.Throws<HtmlNextException>(() => template.Render(new { choose = true }));
        Assert.Equal("state-seed.html", error.SourceName);
        Assert.Contains("cycle", error.Detail);
        Assert.Equal("<output>4:5</output>", template.Render());

        var unused = Compile("<computed name=\"a\" from=\"$b\"></computed><computed name=\"b\" from=\"$a\"></computed>", "<output>Unused</output>");
        Assert.Equal("<output>Unused</output>", unused.Render());
    }

    [Fact]
    public void WaitingAndOwnedNullHaveDifferentAvailability()
    {
        var template = Compile("""
            <state name="waiting" type="number" from="1 / 0"></state>
            <state name="draft" type="number" from="$waiting ? 1 : 2"></state>
            <state name="fallback" type="number" from="default($waiting, 7)"></state>
            <state name="owned" type="number" from="null"></state>
            <state name="isNull" type="boolean" from="$owned = null"></state>
            """, "<output>{$draft}:{$fallback}:{$owned = null}:{$isNull}</output>");
        Assert.Equal("<output>:7:true:true</output>", template.Render());
    }

    [Theory]
    [InlineData("''", "string", "")]
    [InlineData("0", "number", "0")]
    [InlineData("false", "boolean", "false")]
    [InlineData("7", "string", "")]
    [InlineData("'wrong'", "number", "")]
    public void AcceptsFalseySeedsAndLeavesWrongTypesWaiting(string expression, string type, string expected)
    {
        var template = Compile($"<state name=\"draft\" type=\"{type}\" from=\"{expression}\"></state>");
        Assert.Equal("<output>" + expected + "</output>", template.Render());
    }

    [Fact]
    public void ReportsARefusedSeedOnceInBothOutputApis()
    {
        var template = Compile("<state name=\"draft\" type=\"number\" from=\"'wrong'\"></state>", "<output>{$draft}:{$draft}</output>");
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<output>:</output>", template.Render(onDiagnostic: diagnostics.Add));
        Assert.Equal("HNCS004", Assert.Single(diagnostics).Code);
        diagnostics.Clear();
        using var writer = new StringWriter(); template.Write(writer, onDiagnostic: diagnostics.Add);
        Assert.Equal("<output>:</output>", writer.ToString());
        Assert.Equal("HNCS004", Assert.Single(diagnostics).Code);
    }

    [Fact]
    public void SeedsStructuredTypesAndAcceptsValuesOutsideConstraints()
    {
        var template = Compile("""
            <state name="draft" type="object({ count: number, label: string })" from="{ label: 'A', count: 2 }"></state>
            <state name="amount" type="number" min="10" from="5"></state>
            <state name="rows" type="list(number)" from="[1, 2]"></state>
            """, "<output>{$draft.label}:{$draft.count}:{$amount}:{join($rows, ',')}</output>");
        Assert.Equal("<output>A:2:5:1,2</output>", template.Render());
    }

    [Fact]
    public void CopiesSeedRecordsAndListsWhileKeepingInternalAliases()
    {
        var template = Compile("""
            <prop name="source" type="object" open>Source.</prop>
            <state name="draft" from="$source"></state>
            """, "<output>{$draft = $source}:{$draft.left = $draft.right}:{$draft.left.value}:{$draft.items.0 = $draft.left}</output>");
        var shared = new Dictionary<string, object?> { ["value"] = "A" };
        var source = new Dictionary<string, object?> { ["left"] = shared, ["right"] = shared, ["items"] = new[] { shared } };
        Assert.Equal("<output>false:true:A:true</output>", template.Render(new { source }));
        source["self"] = source;
        var cycle = Compile("<prop name=\"source\" type=\"object\" open>Source.</prop><state name=\"draft\" from=\"$source.self\"></state>",
            "<output>{$draft.self = $draft}:{$draft = $source.self}:{$draft.left.value}</output>");
        Assert.Equal("<output>true:false:A</output>", cycle.Render(new { source }));
    }

    [Theory]
    [InlineData("<state name=\"draft\" from=\"\"></state>")]
    [InlineData("<state name=\"draft\" value=\"A\" from=\"'B'\"></state>")]
    [InlineData("<state name=\"draft\" from=\"$missing\"></state>")]
    public void RejectsInvalidInitializerDeclarations(string declaration) =>
        Assert.Throws<HtmlNextException>(() => Compile(declaration));
}
