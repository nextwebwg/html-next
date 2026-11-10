using AngleSharp.Html.Parser;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class CommentRenderingTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void OmitsAuthoredCommentsFromRenderedContentAndSlotFallbacks(bool interactive, bool supplied)
    {
        var source = """
            <template component="x-card"><article>Before<!-- authored-note -->After<slot>Fall<!-- fallback-note -->back</slot></article></template>
            <template component="x-static"><main><x-card>CONTENT</x-card></main></template>
            """.Replace("CONTENT", supplied ? "Given<!-- projected-note -->Text" : "", StringComparison.Ordinal);
        var graph = HtmlNextCompiler.CompileResource(source,
            assets: HtmlNextServerAssets.FromManifest(ClientAssetTests.Manifest(source).ToJsonString()));
        var html = graph.Template("x-static").Render(options: new() { Interactive = interactive });
        Assert.DoesNotContain("-note", html);
        Assert.Equal("BeforeAfter" + (supplied ? "GivenText" : "Fallback"),
            new HtmlParser().ParseDocument(html).QuerySelector("article")!.TextContent);
    }
}
