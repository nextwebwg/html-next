using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ServerStyleAssetsTests
{
    private const string Source = """
        <template component="x-styled"><defs>
          <prop name="inputTone" type="string" default="quiet">Tone.</prop>
          <state name="tone" type="string" from="$inputTone"></state>
          <prop name="title" type="string" default="Hello">Title.</prop>
        </defs><article class="card">{$title}</article><style>:host(:state(tone)) { color: red; }</style></template>
        """;

    private static string Manifest(string source = Source, int version = 1, string[]? stylesheets = null, string[]? tags = null, string[]? states = null) => JsonSerializer.Serialize(new
    {
        server = new { version, hasStyles = true, sources = new[] { new { source = "styled.html", kind = "component", sha256 = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(source))) } },
            stateNames = (tags ?? ["x-styled"]).ToDictionary(tag => tag, _ => states ?? ["tone"]), stylesheets = stylesheets ?? ["assets/components.css"] },
        components = (tags ?? ["x-styled"]).Select(tag => new { tag, source = "styled.html" })
    });

    [Fact]
    public void ConsumesCompiledStylesAndWritesCanonicalRootStateWithoutEmittingStyleSource()
    {
        var assets = HtmlNextServerAssets.FromManifest(Manifest());
        var graph = HtmlNextCompiler.CompileResource(Source, "styled.html", assets);
        Assert.Equal(new[] { "assets/components.css" }, graph.Stylesheets);
        var template = graph.Template("x-styled");
        Assert.Equal("<article class=\"card\" component=\"x-styled\" data-x-styled-state=\"tone tone=quiet\">Hello</article>", template.Render());
        using var writer = new StringWriter(); template.Write(writer, new { inputTone = "", title = "&" });
        Assert.Equal("<article class=\"card\" component=\"x-styled\" data-x-styled-state=\"tone=\">&amp;</article>", writer.ToString());
    }

    [Fact]
    public void EncodesStateValuesWithTheBrowserTokenRulesAndBindsGettersOnce()
    {
        var template = HtmlNextCompiler.Compile(Source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest()));
        var model = new Input();
        Assert.Equal("<article class=\"card\" component=\"x-styled\" data-x-styled-state=\"tone tone=A%20B!%22%26%2B%2F%E2%9C%93\">Title</article>", template.Render(model));
        Assert.Equal((1, 1), (model.ToneReads, model.TitleReads));
    }

    [Fact]
    public async Task ReusesAssetsAndPlansWithoutSharingRequestState()
    {
        var assets = HtmlNextServerAssets.FromManifest(Manifest());
        var template = HtmlNextCompiler.Compile(Source, "styled.html", assets);
        var results = await Task.WhenAll(Enumerable.Range(0, 16).Select(i => Task.Run(() => template.Render(new { inputTone = i.ToString(), title = i.ToString() }))));
        for (var i = 0; i < results.Length; i++) Assert.Equal($"<article class=\"card\" component=\"x-styled\" data-x-styled-state=\"tone tone={i}\">{i}</article>", results[i]);
        Assert.Equal("assets/components.css", Assert.Single(assets.Stylesheets));
    }

    [Fact]
    public void DelegatedRootsCarryBothOwnersWhileNestedComponentsKeepTheirOwnBoundary()
    {
        var source = Source.Replace("{$title}", "{$title}<x-leaf></x-leaf>") + """
            <template component="x-leaf"><defs><state name="tone" type="string" value="leaf"></state></defs><i>Leaf</i><style>:host(:state(tone)) { color: blue; }</style></template>
            <template component="x-shell"><defs><state name="tone" type="string" value="parent"></state></defs><x-styled input-tone="child"></x-styled><style>:host(:state(tone)) { color: green; }</style></template>
            """;
        var graph = HtmlNextCompiler.CompileResource(source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest(source, tags: ["x-styled", "x-leaf", "x-shell"])));
        const string expected = "<article class=\"card\" component=\"x-shell x-styled\" data-x-shell-state=\"tone tone=parent\" data-x-styled-state=\"tone tone=child\">Hello<i component=\"x-leaf\" data-x-leaf-state=\"tone tone=leaf\">Leaf</i></article>";
        Assert.Equal(expected, graph.Template("x-shell").Render());
        using var writer = new StringWriter(); graph.Template("x-shell").Write(writer);
        Assert.Equal(expected, writer.ToString());
    }

    [Theory]
    [InlineData(0d, "count=0")]
    [InlineData(1e21, "count count=1e%2B21")]
    [InlineData(1e-7, "count count=1e-7")]
    [InlineData(1e20, "count count=100000000000000000000")]
    public void SerializesFiniteNumericStateTokens(double inputCount, string token)
    {
        const string source = "<template component=\"x-styled\"><defs><prop name=\"inputCount\" type=\"number\" default=\"0\">Count.</prop><state name=\"count\" type=\"number\" from=\"$inputCount\"></state></defs><b>Number</b><style>:host(:state(count)) {color:red}</style></template>";
        var template = HtmlNextCompiler.Compile(source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest(source, states: ["count"])));
        var expected = $"<b component=\"x-styled\" data-x-styled-state=\"{token}\">Number</b>";
        Assert.Equal(expected, template.Render(new { inputCount }));
        using var writer = new StringWriter(); template.Write(writer, new { inputCount });
        Assert.Equal(expected, writer.ToString());
    }

    [Fact]
    public void PropSelectorsReadAcceptedDefaultsAndNullResets()
    {
        const string source = "<template component=\"x-styled\"><defs><prop name=\"tone\" type=\"string\" default=\"quiet\">Tone.</prop><prop name=\"active\" type=\"boolean\" default=\"true\">Active.</prop></defs><b>Value</b><style>:host([tone]){color:red}:host([active]){font-weight:700}</style></template>";
        var template = HtmlNextCompiler.Compile(source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest(source, states: ["tone", "active"])));
        const string defaults = "<b component=\"x-styled\" data-x-styled-state=\"tone tone=quiet active\">Value</b>";
        Assert.Equal(defaults, template.Render());
        Assert.Equal(defaults, template.Render(new { tone = (object?)null, active = (object?)null }));
        Assert.Equal("<b component=\"x-styled\" data-x-styled-state=\"tone=\">Value</b>", template.Render(new { tone = "", active = false }));
    }

    [Fact]
    public void PropSelectorsKeepRawSelectedDefaultsWhileExpressionsCheckTheirType()
    {
        const string source = """
            <template component="x-styled"><defs>
            <type name="input-value" from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type>
            <prop name="value" type="input-value" default="3">Value.</prop>
            <prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop>
            </defs><b>{$value}</b><style>:host([value]){color:red}</style></template>
            """;
        var template = HtmlNextCompiler.Compile(source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest(source, states: ["value"])));
        const string expected = "<b component=\"x-styled\" data-x-styled-state=\"value value=3\"></b>";
        Assert.Equal(expected, template.Render(new { mode = "text" }));
        using var writer = new StringWriter(); template.Write(writer, new { mode = "text" });
        Assert.Equal(expected, writer.ToString());
    }

    [Theory]
    [InlineData("😀", "tone tone=%F0%9F%98%80")]
    [InlineData("!'()*~", "tone tone=!'()*~")]
    public void PreservesBrowserUriCharactersAndSupplementaryUnicode(string inputTone, string token)
    {
        var template = HtmlNextCompiler.Compile(Source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest()));
        Assert.Equal($"<article class=\"card\" component=\"x-styled\" data-x-styled-state=\"{token}\">Hello</article>", template.Render(new { inputTone }));
    }

    [Fact]
    public void MergesAuthoredRootIdentityAndReplacesManagedStateAttributes()
    {
        var source = Source.Replace("<article class=\"card\">", "<article class=\"card\" component=\"authored\" data-x-styled-state=\"authored\">");
        var template = HtmlNextCompiler.Compile(source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest(source)));
        Assert.Equal("<article class=\"card\" component=\"authored x-styled\" data-x-styled-state=\"tone tone=quiet\">Hello</article>", template.Render());
    }

    [Fact]
    public void ManagedFalsyStateRemovesAuthoredTokens()
    {
        var source = Source.Replace("type=\"string\" from=\"$inputTone\"", "type=\"boolean\" value=\"false\"")
            .Replace("<article class=\"card\">", "<article class=\"card\" data-x-styled-state=\"authored\">");
        var template = HtmlNextCompiler.Compile(source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest(source)));
        Assert.Equal("<article class=\"card\" component=\"x-styled\">Hello</article>", template.Render());
    }

    [Theory]
    [InlineData(true, "<article class=\"card\" component=\"x-styled\" data-x-styled-state=\"tone tone=quiet\">Hello</article>")]
    [InlineData(false, "<article class=\"card\" data-x-styled-state=\"fallback\" component=\"x-styled\">Hello</article>")]
    public void InvalidAuthoredFallbacksRespectTheStyleOwnersManagedAttributes(bool managed, string expected)
    {
        var source = Source.Replace("<article class=\"card\">", "<article class=\"card\" data-x-styled-state=\"fallback\" from:data-x-styled-state=\"1 / 0\">");
        var template = HtmlNextCompiler.Compile(source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest(source, states: managed ? ["tone"] : [])));
        Assert.Equal(expected, template.Render());
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(expected, writer.ToString());
    }

    [Fact]
    public void DelegatedRootsReplaceManagedAncestorStateAttributes()
    {
        var source = Source.Replace("<article class=\"card\">", "<article class=\"card\" data-x-shell-state=\"authored\">") + """
            <template component="x-shell"><defs><state name="tone" type="string" value="parent"></state></defs><x-styled></x-styled><style>:host(:state(tone)){color:red}</style></template>
            """;
        var graph = HtmlNextCompiler.CompileResource(source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest(source, tags: ["x-styled", "x-shell"])));
        Assert.Equal("<article class=\"card\" component=\"x-shell x-styled\" data-x-shell-state=\"tone tone=parent\" data-x-styled-state=\"tone tone=quiet\">Hello</article>", graph.Template("x-shell").Render());
        Assert.Equal("<article class=\"card\" data-x-shell-state=\"authored\" component=\"x-styled\" data-x-styled-state=\"tone tone=quiet\">Hello</article>", graph.Template("x-styled").Render());
    }

    [Fact]
    public void RejectsAStaleSourceRatherThanApplyingMismatchedStyleRequirements()
    {
        var assets = HtmlNextServerAssets.FromManifest(Manifest());
        var error = Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile(Source.Replace("Hello", "Changed"), "styled.html", assets));
        Assert.Equal("HNCS006", error.Code);
        Assert.Contains("fingerprint", error.Detail);
    }

    [Fact]
    public void RejectsAnUnbuiltManifestThatWouldLoseItsStylesheets()
    {
        Assert.Equal("HNCS006", Assert.Throws<HtmlNextException>(() => HtmlNextServerAssets.FromManifest(Manifest(stylesheets: []))).Code);
    }

    [Fact]
    public void RejectsMissingComponentStateRequirements()
    {
        var manifest = JsonNode.Parse(Manifest())!;
        manifest["server"]!["stateNames"]!.AsObject().Clear();
        Assert.Equal("HNCS006", Assert.Throws<HtmlNextException>(() => HtmlNextServerAssets.FromManifest(manifest.ToJsonString())).Code);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void RejectsMalformedUtf16LikeBrowserStateEncoding(bool high)
    {
        var template = HtmlNextCompiler.Compile(Source, "styled.html", HtmlNextServerAssets.FromManifest(Manifest()));
        Assert.Throws<HtmlNextException>(() => template.Render(new { inputTone = high ? "\ud800" : "\udc00" }));
    }

    [Theory]
    [InlineData("1.5")]
    [InlineData("2147483648")]
    [InlineData("null")]
    [InlineData("\"1\"")]
    public void MalformedVersionValuesUseTheAssetDiagnostic(string version)
    {
        var manifest = JsonNode.Parse(Manifest())!;
        manifest["server"]!["version"] = JsonNode.Parse(version);
        Assert.Equal("HNCS006", Assert.Throws<HtmlNextException>(() => HtmlNextServerAssets.FromManifest(manifest.ToJsonString())).Code);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public void RejectsUnknownAssetVersions(int version)
    {
        Assert.Equal("HNCS006", Assert.Throws<HtmlNextException>(() => HtmlNextServerAssets.FromManifest(Manifest(version: version))).Code);
    }

    private sealed class Input
    {
        public int ToneReads { get; private set; }
        public int TitleReads { get; private set; }
        public string inputTone { get { ToneReads++; return "A B!\"&+/✓"; } }
        public string title { get { TitleReads++; return "Title"; } }
    }
}
