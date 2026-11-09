using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ClientAssetTests
{
    internal const string Source = "<template component=\"x-card\"><div>Card</div></template><template component=\"x-static\"><p>Static</p></template>";

    internal static JsonObject Manifest(string source = Source) => new()
    {
        ["server"] = new JsonObject
        {
            ["version"] = 1, ["hydrate"] = true, ["hasStyles"] = false,
            ["sources"] = new JsonArray(new JsonObject { ["source"] = "card.html", ["kind"] = "component", ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(source))) }),
            ["stateNames"] = new JsonObject { ["x-card"] = new JsonArray(), ["x-static"] = new JsonArray() }, ["stylesheets"] = new JsonArray()
        },
        ["components"] = new JsonArray(new JsonObject { ["tag"] = "x-card", ["source"] = "card.html" }, new JsonObject { ["tag"] = "x-static", ["source"] = "card.html" }),
        ["client"] = new JsonObject
        {
            ["version"] = 1, ["module"] = "virtual:html-next/hydrate",
            ["entries"] = new JsonArray("x-card", "x-static"), ["adoption"] = new JsonArray("x-card"), ["creation"] = new JsonArray("x-card"),
            ["components"] = new JsonArray(
                new JsonObject { ["tag"] = "x-card", ["dependencies"] = new JsonArray(), ["adopt"] = true, ["create"] = true, ["reasons"] = new JsonArray("public-access") },
                new JsonObject { ["tag"] = "x-static", ["dependencies"] = new JsonArray(), ["adopt"] = false, ["create"] = false, ["reasons"] = new JsonArray() })
        }
    };

    [Fact]
    public void ReadsTheCompilerOwnedPlanWithoutSelectingAdditionalComponents()
    {
        var assets = HtmlNextServerAssets.FromManifest(Manifest().ToJsonString());
        var graph = HtmlNextCompiler.CompileResource(Source, assets: assets);
        Assert.True(assets.Hydrate);
        var client = Assert.IsType<HtmlNextClientPlan>(assets.Client);
        Assert.Same(client, graph.Client);
        Assert.Same(client, graph.Template("x-card").Client);
        Assert.Equal("virtual:html-next/hydrate", client.Module);
        Assert.Equal(new[] { "x-card", "x-static" }, client.Entries);
        Assert.Equal(new[] { "x-card" }, client.Adoption);
        Assert.Equal(new[] { "x-card" }, client.Creation);
        Assert.Equal("public-access", Assert.Single(client.Components[0].Reasons));
        Assert.False(client.Components[1].Adopt);
        Assert.Throws<NotSupportedException>(() => ((IList<string>)client.Adoption).Add("x-static"));
    }

    [Theory]
    [InlineData("version")]
    [InlineData("unknown-tag")]
    [InlineData("duplicate")]
    [InlineData("flags")]
    [InlineData("dependencies")]
    [InlineData("creation")]
    public void RejectsAnIncompatibleOrInconsistentClientPlan(string defect)
    {
        var manifest = Manifest();
        var client = manifest["client"]!;
        switch (defect)
        {
            case "version": client["version"] = 2; break;
            case "unknown-tag": client["entries"]!.AsArray().Add("x-missing"); break;
            case "duplicate": client["adoption"]!.AsArray().Add("x-card"); break;
            case "flags": client["components"]![0]!["adopt"] = false; break;
            case "dependencies": client["components"]![0]!["dependencies"]!.AsArray().Add("x-missing"); break;
            case "creation": client["creation"]!.AsArray().Clear(); break;
        }
        Assert.Equal("HNCS006", Assert.Throws<HtmlNextException>(() => HtmlNextServerAssets.FromManifest(manifest.ToJsonString())).Code);
    }

    [Fact]
    public void KeepsStyleOnlyManifestsUsableWithoutClaimingHydration()
    {
        var manifest = Manifest();
        manifest.Remove("client");
        manifest["server"]!.AsObject().Remove("hydrate");
        var assets = HtmlNextServerAssets.FromManifest(manifest.ToJsonString());
        Assert.False(assets.Hydrate);
        Assert.Null(assets.Client);
    }
}
