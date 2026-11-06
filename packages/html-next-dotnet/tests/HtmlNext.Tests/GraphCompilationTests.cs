using System.Security.Cryptography;
using System.Text;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class GraphCompilationTests
{
    private const string Leaf = "<template component=\"x-leaf\"><p>Leaf</p></template>";

    [Fact]
    public void CompilesEveryCarrierAndIgnoresResourceAndCarrierMetadata()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <title>{ignored}</title><meta name="description" content="Ignored"><link rel="stylesheet" href="never.css">
            <template component="x-one"><meta name="app:page" content="one"><title>Ignored</title><p>One</p></template>
            <template component="x-two"><b>Two</b><link rel="alternate" href="never.html"></template>
            """, "components.html");
        Assert.Equal(new[] { "x-one", "x-two" }, graph.Templates.Keys.Order(StringComparer.Ordinal));
        Assert.Equal("<p>One</p>", graph.Template("x-one").Render());
        Assert.Equal("<b>Two</b>", graph.Template("x-two").Render());
        Assert.Throws<KeyNotFoundException>(() => graph.Template("x-missing"));
    }

    [Fact]
    public async Task ResolvesDeclaredEdgesOncePerRequestAndRetainsCanonicalFingerprints()
    {
        const string entry = "<link rel=\"component\" href=\"./leaf.html\"><link rel=\"component\" href=\"./leaf.html\"><template component=\"x-page\"><x-leaf></x-leaf></template>";
        var calls = new List<(string Specifier, string? Referrer)>();
        var graph = await HtmlNextCompiler.CompileAsync(["entry"], (specifier, referrer, token) =>
        {
            Assert.False(token.IsCancellationRequested);
            calls.Add((specifier, referrer));
            return ValueTask.FromResult(specifier == "entry" ? new HtmlNextSource("app/page.html", entry, "r1") : new HtmlNextSource("app/leaf.html", Leaf, "r2"));
        });
        Assert.Equal(new[] { ("entry", (string?)null), ("./leaf.html", "app/page.html") }, calls);
        Assert.Equal("<p>Leaf</p>", graph.Template("x-page").Render());
        Assert.Equal(2, graph.Sources.Count);
        var source = Assert.Single(graph.Sources, source => source.Id == "app/page.html");
        Assert.Equal("r1", source.Revision);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(entry))), source.Sha256);
        Assert.Equal(new[] { "app/leaf.html" }, source.Dependencies);
    }

    [Fact]
    public async Task RetainsBrowserModuleReferencesWithoutLoadingOrExecutingThem()
    {
        var calls = new List<string>();
        var graph = await HtmlNextCompiler.CompileAsync(["entry"], (specifier, _, _) =>
        {
            calls.Add(specifier);
            return ValueTask.FromResult(new HtmlNextSource("page.html", "<template component=\"x-module\" module=\"./never-executed.js\"><p $ref=\"mount\">Baseline</p></template>"));
        });
        Assert.Equal(new[] { "entry" }, calls);
        var module = Assert.Single(graph.Modules);
        Assert.Equal("x-module", module.Component);
        Assert.Equal("page.html", module.SourceId);
        Assert.Equal("./never-executed.js", module.Specifier);
        Assert.Equal(module, graph.Template("x-module").Module);
        Assert.Equal("<p>Baseline</p>", graph.Template("x-module").Render());
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("""<template component="x-module" module=" "><p>Text</p></template>"""));
    }

    [Fact]
    public async Task CyclicResourceLinksDeduplicateCanonicalDefinitions()
    {
        var graph = await HtmlNextCompiler.CompileAsync(["a"], (specifier, _, _) => ValueTask.FromResult(specifier == "a"
            ? new HtmlNextSource("a", "<link rel=\"component\" href=\"b\"><template component=\"x-a\"><p>A</p></template>")
            : new HtmlNextSource("b", "<link rel=\"component\" href=\"a\">" + Leaf)));
        Assert.Equal(2, graph.Sources.Count);
        Assert.Equal("<p>A</p>", graph.Template("x-a").Render());
    }

    [Theory]
    [InlineData("<script type=\"application/json\">{}</script>")]
    [InlineData("<base href=\"/other/\">")]
    [InlineData("<meta http-equiv=\"refresh\" content=\"0;url=/other\">")]
    [InlineData("<link rel=\"import\" href=\"old.html\">")]
    [InlineData("<style>p { color:red }</style>")]
    [InlineData("<div>Body</div>")]
    [InlineData("<template><p>Not a component</p></template>")]
    [InlineData("<meta name=\"app:page\" content=\"one\" onclick=\"run()\">")]
    public void RejectsActiveOrInvalidResourceNodes(string node)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(node + Leaf, "invalid.html"));
    }

    [Fact]
    public void RejectsMissingDefinitionsDuplicateTagsAndUnresolvedCalls()
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource("<title>Only metadata</title>"));
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(Leaf + Leaf));
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource("<link rel=\"component\" href=\"leaf.html\">" + Leaf));
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource("<template component=\"x-page\"><div><x-missing $if=\"false\"></x-missing></div></template>"));
    }

    [Fact]
    public async Task RejectsConflictingCanonicalSourcesAndDuplicateTagsAcrossResources()
    {
        await Assert.ThrowsAsync<HtmlNextException>(async () => await HtmlNextCompiler.CompileAsync(["a", "b"],
            (specifier, _, _) => ValueTask.FromResult(new HtmlNextSource("same", specifier == "a" ? Leaf : Leaf.Replace("Leaf", "Changed", StringComparison.Ordinal)))));
        await Assert.ThrowsAsync<HtmlNextException>(async () => await HtmlNextCompiler.CompileAsync(["a", "b"],
            (specifier, _, _) => ValueTask.FromResult(new HtmlNextSource(specifier, Leaf))));
    }

    [Fact]
    public async Task CancelsAnAwaitedResolverAndAssociatesDependencyFailuresWithTheImporter()
    {
        using var cancellation = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = HtmlNextCompiler.CompileAsync(["entry"], async (_, _, token) =>
        {
            entered.SetResult();
            await release.Task.WaitAsync(token);
            return new HtmlNextSource("entry", Leaf);
        }, cancellation.Token).AsTask();
        await entered.Task;
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        var failure = await Assert.ThrowsAsync<HtmlNextException>(async () => await HtmlNextCompiler.CompileAsync(["entry"],
            (specifier, _, _) => specifier == "entry"
                ? ValueTask.FromResult(new HtmlNextSource("page.html", "<link rel=\"component\" href=\"missing.html\">" + Leaf))
                : throw new IOException("Missing")));
        Assert.Equal("page.html", failure.SourceName);
        Assert.IsType<IOException>(failure.InnerException);
    }

    [Fact]
    public async Task CancellationAndResolverErrorsDoNotPoisonLaterCompilations()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var called = false;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await HtmlNextCompiler.CompileAsync(["a"], (_, _, _) =>
        {
            called = true;
            return ValueTask.FromResult(new HtmlNextSource("a", Leaf));
        }, cancellation.Token));
        Assert.False(called);
        await Assert.ThrowsAsync<HtmlNextException>(async () => await HtmlNextCompiler.CompileAsync(["a"],
            (_, _, _) => throw new IOException("Source unavailable")));
        var graph = await HtmlNextCompiler.CompileAsync(["a"], (_, _, _) => ValueTask.FromResult(new HtmlNextSource("a", Leaf)));
        Assert.Equal("<p>Leaf</p>", graph.Template("x-leaf").Render());
    }
}
