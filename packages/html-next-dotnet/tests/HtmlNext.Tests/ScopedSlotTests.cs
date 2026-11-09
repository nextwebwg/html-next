using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ScopedSlotTests
{
    public static IEnumerable<object[]> Cases(string group)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "scoped-slots.json")));
        foreach (var entry in document.RootElement.GetProperty(group).EnumerateArray())
            if (group == "valid") yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty("native").GetString()!, entry.GetProperty("diagnostics").GetInt32()];
            else yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty("reason").GetString()!];
    }

    [Theory]
    [MemberData(nameof(Cases), "valid")]
    public async Task RendersTypedInputsWithConsumerScopeAndIsolatedPlans(string name, string source, string expected, int diagnosticCount)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            var diagnostics = new List<HtmlNextDiagnostic>();
            Assert.Equal(expected, template.Render(onDiagnostic: diagnostics.Add));
            Assert.Equal(diagnosticCount, diagnostics.Count);
            diagnostics.Clear();
            using var writer = new StringWriter(); template.Write(writer, onDiagnostic: diagnostics.Add);
            Assert.Equal(expected, writer.ToString());
            Assert.Equal(diagnosticCount, diagnostics.Count);
        })));
    }

    [Fact]
    public void LeavesAnUnreadOptionalOuterBindingLazy()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-card"><defs><slot><prop name="label" type="string">Label.</prop></slot></defs><section><slot></slot></section></template>
            <template component="x-page"><defs><computed name="label" from="$label"></computed></defs><main><x-card><template slot=""><b>Ready</b></template></x-card></main></template>
            """).Template("x-page");
        const string expected = "<main><section><?start slot=\"\" scoped=\"\"?><b>Ready</b><?end?><template carrier=\"x-card\"><template slot=\"\"><b>Ready</b></template></template></section></main>";
        Assert.Equal(expected, template.Render());
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(expected, writer.ToString());
    }

    [Fact]
    public void ReadsApplicationFieldsOnceAcrossRepeatedScopedOutletsAndOutputPasses()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-card"><defs><prop name="item" type="object({ label: string })" required>Item.</prop><slot><prop name="label" type="string" required>Label.</prop></slot></defs><section><slot $each="row of [1, 2]" from:label="$item.label"></slot></section></template>
            <template component="x-page"><defs><prop name="item" type="object({ label: string })" required>Item.</prop></defs><main><x-card from:item="$item"><template slot=""><b>{$label}</b></template></x-card></main></template>
            """).Template("x-page");
        const string expected = "<main><section><?start slot=\"\" scoped=\"\"?><b>Caller</b><?end?><?start slot=\"\" scoped=\"\"?><b>Caller</b><?end?><template carrier=\"x-card\"><template slot=\"\"><b>{$label}</b></template></template></section></main>";
        var item = new CountingItem();
        Assert.Equal(expected, template.Render(new { item }));
        Assert.Equal(1, item.Reads);
        item = new CountingItem();
        using var writer = new StringWriter(); template.Write(writer, new { item });
        Assert.Equal(expected, writer.ToString());
        Assert.Equal(1, item.Reads);
    }

    [Fact]
    public void DeduplicatesSlotWarningsAndForwardsNestedComponentDiagnostics()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-required"><defs><prop name="label" type="string" required>Label.</prop></defs><i>{$label}</i></template>
            <template component="x-card"><defs><state name="text" type="string" value="bad"></state><slot><prop name="count" type="number" default="7">Count.</prop></slot></defs><section><slot $each="row of [1, 2]" from:count="$text"></slot></section></template>
            <template component="x-page"><main><x-card><template slot=""><b>{$count}</b><x-required></x-required></template></x-card></main></template>
            """).Template("x-page");
        const string expected = "<main><section><?start slot=\"\" scoped=\"\"?><b>7</b><i></i><?end?><?start slot=\"\" scoped=\"\"?><b>7</b><i></i><?end?><template carrier=\"x-card\"><template slot=\"\"><b>{$count}</b><x-required></x-required></template></template></section></main>";
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal(expected, template.Render(onDiagnostic: diagnostics.Add));
        Assert.Equal(["HNCS004", "HNCS003", "HNCS003"], diagnostics.Select(item => item.Code));
        diagnostics.Clear();
        using var writer = new StringWriter(); template.Write(writer, onDiagnostic: diagnostics.Add);
        Assert.Equal(expected, writer.ToString());
        Assert.Equal(["HNCS004", "HNCS003", "HNCS003"], diagnostics.Select(item => item.Code));
    }

    private sealed class CountingItem
    {
        public int Reads;
        public string label { get { Reads++; return "Caller"; } }
    }

    [Theory]
    [MemberData(nameof(Cases), "renderInvalid")]
    public void RejectsPlainContentForAScopedOutlet(string name, string source, string reason)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        var error = Assert.Throws<HtmlNextException>(() => template.Render());
        Assert.Matches("(?i)" + reason, error.Detail);
        using var writer = new StringWriter();
        Assert.Throws<HtmlNextException>(() => template.Write(writer));
    }

    [Theory]
    [MemberData(nameof(Cases), "invalid")]
    public void RejectsMalformedDeclarationsAndOutlets(string name, string source, string reason)
    {
        var error = Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(source, name + ".html"));
        Assert.Matches("(?i)" + reason, error.Detail);
    }
}
