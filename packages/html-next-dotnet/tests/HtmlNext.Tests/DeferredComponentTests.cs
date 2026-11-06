using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class DeferredComponentTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "deferred-components.json")));
        foreach (var entry in document.RootElement.EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty("native").GetString()!];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task RendersCallerOwnedContentWithoutInitializingUnplacedComponents(string name, string source, string expected)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            var diagnostics = new List<HtmlNextDiagnostic>();
            Assert.Equal(expected, template.Render(onDiagnostic: diagnostics.Add));
            using var writer = new StringWriter(); template.Write(writer, onDiagnostic: diagnostics.Add);
            Assert.Equal(expected, writer.ToString());
            Assert.Empty(diagnostics);
        })));
    }
}
