using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ElementReferenceTests
{
    public static IEnumerable<object[]> Cases(string group)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "element-references.json")));
        foreach (var entry in document.RootElement.GetProperty(group).EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty(group == "valid" ? "native" : "reason").GetString()!];
    }

    [Theory]
    [MemberData(nameof(Cases), "valid")]
    public async Task ConsumesReferenceDirectivesAndPreservesInertSource(string name, string source, string expected)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            Assert.Equal(expected, template.Render());
            using var writer = new StringWriter(); template.Write(writer);
            Assert.Equal(expected, writer.ToString());
        })));
    }

    [Theory]
    [MemberData(nameof(Cases), "invalid")]
    public void RejectsInvalidOrDuplicateReferencesBeforeRendering(string name, string source, string reason)
    {
        var error = Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(source, name + ".html"));
        Assert.Matches("(?i)" + reason, error.Detail);
    }
}
