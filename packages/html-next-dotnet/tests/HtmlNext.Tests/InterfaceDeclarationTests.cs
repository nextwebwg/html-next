using System.Text.Json;
using System.Text.RegularExpressions;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class InterfaceDeclarationTests
{
    public static IEnumerable<object[]> Cases(string group)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "interface-declarations.json")));
        foreach (var entry in document.RootElement.GetProperty(group).EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty(group == "valid" ? "expected" : "reason").GetString()!];
    }

    [Theory]
    [MemberData(nameof(Cases), "valid")]
    public async Task ValidatesInterfacesWithoutRenderingOrBindingThem(string name, string source, string expected)
    {
        var template = HtmlNextCompiler.Compile(source, name + ".html");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            var model = new UnreadInterface();
            Assert.Equal(expected, template.Render(model));
            using var writer = new StringWriter(); template.Write(writer, model);
            Assert.Equal(expected, writer.ToString());
        })));
    }

    [Theory]
    [MemberData(nameof(Cases), "invalid")]
    public void RejectsMalformedInterfacesDuringCompilation(string name, string source, string reason)
    {
        var error = Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile(source, name + ".html"));
        Assert.Equal(name + ".html", error.SourceName);
        Assert.Matches(new Regex(reason, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), error.Detail);
    }

    public sealed class UnreadInterface
    {
        public object ready => throw new InvalidOperationException("Event metadata was bound as input.");
        public object find => throw new InvalidOperationException("Request metadata was bound as input.");
    }
}
