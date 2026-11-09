using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class AttributeForwardingTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "attribute-forwarding.json")));
        foreach (var entry in document.RootElement.EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty("expected").GetString()!];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void ForwardsOnlyUnclaimedInvocationAttributesInAuthoredOrder(string name, string source, string expected)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        Assert.Equal(expected, template.Render());
        using var writer = new StringWriter();
        template.Write(writer);
        Assert.Equal(expected, writer.ToString());
    }
}
