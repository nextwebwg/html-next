using AngleSharp.Html.Parser;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ApplicationCompilationTests
{
    [Fact]
    public async Task CompilesApplicationMarkupAgainstRetainedTypedComponents()
    {
        var reads = 0;
        var library = await HtmlNextCompiler.CompileAsync(["library"], (_, _, _) =>
        {
            reads++;
            return ValueTask.FromResult(new HtmlNextSource("library", """
                <template component="x-label"><defs><prop name="count" type="integer" default="2">Count.</prop></defs><b>{$count}<slot></slot></b></template>
                """));
        });
        var retained = library.Template("x-label");
        var application = library.CompileApplication("""
            <template component="x-application"><defs><prop name="count" type="integer">Count.</prop></defs><main><x-label from:count="$count"> items</x-label></main></template>
            """);
        Assert.Equal("3 items", new HtmlParser().ParseDocument(application.Render(new { count = 3 })).QuerySelector("main > b")!.TextContent);
        using var writer = new StringWriter(); application.Write(writer, new { count = 4 });
        Assert.Equal("4 items", new HtmlParser().ParseDocument(writer.ToString()).QuerySelector("main > b")!.TextContent);
        Assert.Same(retained, library.Template("x-label"));
        Assert.Equal("2", new HtmlParser().ParseDocument(retained.Render()).QuerySelector("b")!.TextContent);
        Assert.Equal(1, reads);
        Assert.False(library.Templates.ContainsKey("x-application"));
    }

    [Fact]
    public async Task KeepsAcceptedChildContractsIsolatedAcrossApplicationCompilations()
    {
        var library = HtmlNextCompiler.CompileResource("""
            <template component="x-column"><defs><prop name="label" type="string">Label.</prop></defs><b>{$label}<slot></slot></b></template>
            <template component="x-table"><defs><slot accepts="x-column" as="columns"></slot></defs><section><article $each="column of $columns"><h2>{$column.label}</h2><slot of="$column"></slot></article></section></template>
            """);
        var source = """
            <template component="x-application"><defs><prop name="label" type="string">Label.</prop></defs><main><x-table><x-column from:label="$label">Body</x-column></x-table></main></template>
            """;
        var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(index => Task.Run(() => library.CompileApplication(source).Render(new { label = index.ToString() }))));
        for (var index = 0; index < results.Length; index++)
        {
            var document = new HtmlParser().ParseDocument(results[index]);
            var row = Assert.Single(document.QuerySelectorAll("main > section > article"));
            Assert.Equal(index.ToString(), row.QuerySelector("h2")!.TextContent);
            Assert.Equal(index + "Body", row.TextContent);
        }
        Assert.Equal(2, library.Templates.Count);
    }

    [Fact]
    public void PreservesOrdinaryAcceptedComponentFilteringAcrossTheLibraryBoundary()
    {
        var library = HtmlNextCompiler.CompileResource("""
            <template component="x-column"><b><slot></slot></b></template>
            <template component="x-list"><defs><slot accepts="x-column"></slot></defs><section><slot></slot></section></template>
            """);
        var template = library.CompileApplication("""
            <template component="x-application"><main><x-list><x-column>Body</x-column><i>Rejected</i></x-list></main></template>
            """);
        var diagnostics = new List<HtmlNextDiagnostic>();
        var document = new HtmlParser().ParseDocument(template.Render(onDiagnostic: diagnostics.Add));
        Assert.Equal("Body", document.QuerySelector("main > section > b")?.TextContent);
        Assert.Null(document.QuerySelector("main > section > i"));
        Assert.Single(diagnostics, diagnostic => diagnostic.Code == "HNCS007");
    }

    [Fact]
    public void ReusesTheLibraryAssetsAndItsExistingClientSelection()
    {
        var assets = HtmlNextServerAssets.FromManifest(ClientAssetTests.Manifest().ToJsonString());
        var library = HtmlNextCompiler.CompileResource(ClientAssetTests.Source, assets: assets);
        var template = library.CompileApplication("""
            <template component="x-application"><main><x-card></x-card><x-static></x-static></main></template>
            """);
        Assert.Same(library.Client, template.Client);
        var html = template.Render(options: new() { Interactive = true });
        var document = new HtmlParser().ParseDocument(html);
        Assert.Equal("Card", document.QuerySelector("main > div[component='x-card']")?.TextContent);
        Assert.Equal("Static", document.QuerySelector("main > p[component='x-static']")?.TextContent);
        Assert.Single(document.QuerySelectorAll("[data-html-next-instance]"));
        Assert.Equal(new[] { "x-card" }, library.Client!.Adoption);
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(ClientAssetTests.Source.Replace("Card", "Changed", StringComparison.Ordinal), assets: assets));
    }

    [Fact]
    public void FailedApplicationsLeaveTheRetainedLibraryUsable()
    {
        var library = HtmlNextCompiler.CompileResource("<template component=\"x-leaf\"><b>Leaf</b></template>");
        foreach (var source in new[]
        {
            "<template component=\"x-leaf\"><b>Duplicate</b></template>",
            "<template component=\"x-app\"><x-missing></x-missing></template>",
            "<link rel=\"component\" href=\"other.html\"><template component=\"x-app\"><b>Dependency</b></template>"
        }) Assert.Throws<HtmlNextException>(() => library.CompileApplication(source));
        Assert.Equal("<b>Leaf</b>", library.Template("x-leaf").Render());
        Assert.Equal("<main><b>Leaf</b></main>", library.CompileApplication("<template component=\"x-app\"><main><x-leaf></x-leaf></main></template>").Render());
    }
}
