using System.Text.Json.Nodes;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class PreparedModuleAssetsTests
{
    private static string Manifest(string? modules)
    {
        var manifest = JsonNode.Parse("""
            {"server":{"version":1,"hasStyles":false,"sources":[{"source":"card.html","kind":"component","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}],"stateNames":{"x-card":[]},"stylesheets":[]},"components":[{"tag":"x-card","source":"card.html"}]}
            """)!;
        if (modules is not null) manifest["server"]!["preparedModules"] = JsonNode.Parse(modules);
        return manifest.ToJsonString();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("[]")]
    public void AssetsWithoutPreparedModulesKeepTheirExistingMeaning(string? modules)
    {
        Assert.Empty(HtmlNextServerAssets.FromManifest(Manifest(modules)).PreparedModules);
    }

    [Fact]
    public void KeepsTheCompilerSourceRevisionForItsComponent()
    {
        var assets = HtmlNextServerAssets.FromManifest(Manifest("""
            [{"tag":"x-card","source":"opaque-compiler-revision"}]
            """));
        var identity = Assert.Single(assets.PreparedModules);
        Assert.Equal("x-card", identity.Key);
        Assert.Equal("opaque-compiler-revision", identity.Value);
    }

    [Theory]
    [InlineData("[{\"tag\":\"x-other\",\"source\":\"revision\"}]")]
    [InlineData("[{\"tag\":\"x-card\",\"source\":\"first\"},{\"tag\":\"x-card\",\"source\":\"second\"}]")]
    [InlineData("[{\"tag\":\"x-card\",\"source\":\"\"}]")]
    [InlineData("[{\"tag\":\"x-card\",\"source\":3}]")]
    [InlineData("[{\"tag\":\"x-card\"}]")]
    [InlineData("{}")]
    public void RejectsUnownedDuplicateOrMalformedPreparationIdentities(string modules)
    {
        Assert.Equal("HNCS006", Assert.Throws<HtmlNextException>(() => HtmlNextServerAssets.FromManifest(Manifest(modules))).Code);
    }
}
