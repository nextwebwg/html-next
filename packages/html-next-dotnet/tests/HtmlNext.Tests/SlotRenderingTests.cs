using System.Text.Json;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class SlotRenderingTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "slot-rendering.json")));
        foreach (var entry in document.RootElement.EnumerateArray()) yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty("entry").GetString()!, entry.GetProperty("native").GetString()!, entry.GetProperty("expected").GetString()!];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task RendersProjectionAndFallbacksWithIsolatedReusablePlans(string name, string source, string entry, string expected, string visible)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template(entry);
        using var parsed = new HtmlParser().ParseDocument(template.Render());
        var root = parsed.Body!.FirstElementChild!;
        foreach (var carrier in root.QuerySelectorAll("template[carrier]")) carrier.Remove();
        RemoveMarks(root);
        Assert.Equal(visible, root.OuterHtml);
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            Assert.Equal(expected, template.Render());
            using var writer = new StringWriter(); template.Write(writer);
            Assert.Equal(expected, writer.ToString());
        })));
    }

    private static void RemoveMarks(INode node)
    {
        foreach (var child in node.ChildNodes.ToArray())
            if (child is IComment comment && (comment.Data.StartsWith("?start slot=", StringComparison.Ordinal) || comment.Data.StartsWith("?marker slot=", StringComparison.Ordinal) || comment.Data == "?end?")) node.RemoveChild(child);
            else RemoveMarks(child);
    }

    [Fact]
    public void PreservesUnusedEagerBindingsAndDefersComponentSetup()
    {
        var source = """
            <template component="x-child"><defs><prop name="label" type="string" required>Label.</prop></defs><b>{$label}</b></template>
            <template component="x-hidden"><section></section></template>
            <template component="x-page"><defs><prop name="label" type="string">Label.</prop></defs><article><x-hidden><p from:title="$label">{$label}<x-child></x-child></p><template $each="row of [1, 2]"><x-child></x-child></template></x-hidden></article></template>
            """;
        var template = HtmlNextCompiler.CompileResource(source).Template("x-page");
        var diagnostics = new List<HtmlNextDiagnostic>();
        const string expected = "<article><section><template carrier=\"x-hidden\"><p title=\"A &amp; B\">A &amp; B<x-child></x-child></p><x-child></x-child><x-child></x-child></template></section></article>";
        Assert.Equal(expected, template.Render(new { label = "A & B" }, onDiagnostic: diagnostics.Add));
        using var writer = new StringWriter(); template.Write(writer, new { label = "A & B" }, onDiagnostic: diagnostics.Add);
        Assert.Equal(expected, writer.ToString());
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PlacesSharedRootCarriersInOuterToInnerOrder()
    {
        var source = """
            <template component="x-leaf"><section></section></template>
            <template component="x-relay"><x-leaf><b>Inner</b></x-leaf></template>
            <template component="x-page"><article><x-relay><i>Outer</i></x-relay></article></template>
            """;
        AssertOutput(source, "<article><section><template carrier=\"x-relay\"><i>Outer</i></template><template carrier=\"x-leaf\"><b>Inner</b></template></section></article>");
    }

    [Fact]
    public void KeepsForwardedConsumerNodesInTheirOwningCarrier()
    {
        var source = """
            <template component="x-hidden"><section></section></template>
            <template component="x-relay"><article><x-hidden><b><slot></slot></b></x-hidden></article></template>
            <template component="x-page"><main><x-relay><i>Caller</i></x-relay></main></template>
            """;
        AssertOutput(source, "<main><article><section><template carrier=\"x-hidden\"><b><?start slot=\"\"?><?end?></b></template></section><template carrier=\"x-relay\"><i>Caller</i></template></article></main>");
    }

    [Fact]
    public void PlainContentAppearsAtItsFirstOutletOnly()
    {
        var source = """
            <template component="x-card"><section><slot $each="row of ['First', 'Second']">{$row}</slot></section></template>
            <template component="x-page"><div><x-card><b>Body</b></x-card></div></template>
            """;
        AssertOutput(source, "<div><section><?start slot=\"\"?><b>Body</b><?end?><?start slot=\"\" fallback=\"\"?>Second<?end?></section></div>");
    }

    [Fact]
    public void ATemplateRendersAfreshAtEveryOutlet()
    {
        var source = """
            <template component="x-card"><section><slot $each="row of [1, 2]"></slot></section></template>
            <template component="x-page"><div><x-card><template slot=""><b>Body</b></template></x-card></div></template>
            """;
        AssertOutput(source, "<div><section><?start slot=\"\" scoped=\"\"?><b>Body</b><?end?><?start slot=\"\" scoped=\"\"?><b>Body</b><?end?><template carrier=\"x-card\"><template slot=\"\"><b>Body</b></template></template></section></div>");
    }

    [Fact]
    public void SerializesForwardedFallbackWhileItsReceivingSlotIsHidden()
    {
        AssertOutput(
            """
            <template component='x-hidden'><section></section></template><template component='x-relay'><article><x-hidden><b><slot>Empty</slot></b></x-hidden></article></template><template component='x-page'><main><x-relay></x-relay></main></template>
            """,
            "<main><article><section><template carrier=\"x-hidden\"><b><?start slot=\"\" fallback=\"\"?>Empty<?end?></b></template></section></article></main>");
    }

    [Fact]
    public void RendersForwardedLazyContentWhileItsReceivingSlotIsHidden()
    {
        AssertOutput(
            """
            <template component='x-hidden'><section></section></template><template component='x-relay'><article><x-hidden><b><slot>Empty</slot></b></x-hidden></article></template><template component='x-page'><main><x-relay><template slot=''><i>Caller</i></template></x-relay></main></template>
            """,
            "<main><article><section><template carrier=\"x-hidden\"><b><?start slot=\"\" scoped=\"\"?><i>Caller</i><?end?></b></template></section><template carrier=\"x-relay\"><template slot=\"\"><i>Caller</i></template></template></article></main>");
    }

    [Fact]
    public void DefersChildSetupInsideHiddenForwardedLazyContent()
    {
        var source = """
            <template component="x-required"><defs><prop name="label" type="string" required>Label.</prop></defs><em>{$label}</em></template>
            <template component="x-hidden"><section></section></template>
            <template component="x-relay"><article><x-hidden><b><slot></slot></b></x-hidden></article></template>
            <template component="x-page"><main><x-relay><template slot=""><x-required></x-required></template></x-relay></main></template>
            """;
        var template = HtmlNextCompiler.CompileResource(source).Template("x-page");
        var diagnostics = new List<HtmlNextDiagnostic>();
        const string expected = "<main><article><section><template carrier=\"x-hidden\"><b><?start slot=\"\" scoped=\"\"?><x-required></x-required><?end?></b></template></section><template carrier=\"x-relay\"><template slot=\"\"><x-required></x-required></template></template></article></main>";
        Assert.Equal(expected, template.Render(onDiagnostic: diagnostics.Add));
        using var writer = new StringWriter(); template.Write(writer, onDiagnostic: diagnostics.Add);
        Assert.Equal(expected, writer.ToString());
        Assert.Empty(diagnostics);
    }

    private static void AssertOutput(string source, string expected)
    {
        var template = HtmlNextCompiler.CompileResource(source).Template("x-page");
        Assert.Equal(expected, template.Render());
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(expected, writer.ToString());
    }

    [Theory]
    [InlineData("<slot name='bad-name'></slot>")]
    [InlineData("<slot name=''></slot>")]
    [InlineData("<slot from:name='null'></slot>")]
    [InlineData("<template $slot='bad-name'></template>")]
    public void RejectsMalformedSlotOutlets(string outlets)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("<template component='x-card'><section>" + outlets + "</section></template>"));
    }

    [Theory]
    [InlineData("<b>Plain</b>", "<main><section><b>Plain</b>SecondFallback</section></main>")]
    [InlineData("<template slot=''>Templated</template>", "<main><section>TemplatedTemplated</section></main>")]
    public async Task RepeatedOutletsKeepPlainContentOnceAndRenderTemplatesAfresh(string content, string expected)
    {
        var template = HtmlNextCompiler.CompileResource("<template component='x-card'><section><slot>FirstFallback</slot><slot>SecondFallback</slot></section></template><template component='x-page'><main><x-card>" + content + "</x-card></main></template>").Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            var html = template.Render();
            using var writer = new StringWriter(); template.Write(writer);
            Assert.Equal(html, writer.ToString());
            using var document = new HtmlParser().ParseDocument(html);
            var root = document.Body!.FirstElementChild!;
            foreach (var carrier in root.QuerySelectorAll("template[carrier]")) carrier.Remove();
            RemoveMarks(root);
            Assert.Equal(expected, root.OuterHtml);
        })));
    }

    [Theory]
    [InlineData("<b slot='bad-name'></b>")]
    [InlineData("<b from:slot='null'></b>")]
    [InlineData("<template slot='$name'></template>")]
    public void RejectsComputedConsumerSlotNames(string content)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource("<template component='x-card'><section></section></template><template component='x-page'><main><x-card>" + content + "</x-card></main></template>"));
    }

    [Theory]
    [InlineData("<div $if=\"true\"></div>")]
    [InlineData("<div $each=\"row of [1]\"></div>")]
    [InlineData("<x-child $if=\"true\"></x-child>")]
    public void AComponentAlwaysSelectsOneRoot(string root)
    {
        var source = "<template component=\"x-child\"><b></b></template><template component=\"x-page\">" + root + "</template>";
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(source));
    }
}
