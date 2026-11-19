using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class DeferredComponentTests
{
    [Fact]
    public async Task DeferredBindingsSnapshotCallerGettersOncePerOutputApi()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-leaf" module="./never-executed.js"><defs><prop name="label" type="string" required>Label.</prop></defs><p></p></template>
            <template component="x-unused"><section></section></template>
            <template component="x-page"><defs><prop name="row" type="object({ label: string })">Row.</prop></defs><main><x-unused><x-leaf from:label="$row.label"><b from:title="$row.label">{$row.label}</b></x-leaf><x-leaf></x-leaf></x-unused></main></template>
            """).Template("x-page");
        const string expected = "<main><section><template carrier=\"x-unused\"><x-leaf label=\"Ready\"><b title=\"Ready\">Ready</b></x-leaf><x-leaf></x-leaf></template></section></main>";
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            var row = new CountingRow();
            var diagnostics = new List<HtmlNextDiagnostic>();
            Assert.Equal(expected, template.Render(new { row }, onDiagnostic: diagnostics.Add));
            Assert.Equal(1, row.Reads);
            using var writer = new StringWriter(); template.Write(writer, new { row }, onDiagnostic: diagnostics.Add);
            Assert.Equal(expected, writer.ToString());
            Assert.Equal(2, row.Reads);
            Assert.Empty(diagnostics);
        })));
    }

    private sealed class CountingRow
    {
        public int Reads;
        public string label { get { Reads++; return "Ready"; } }
    }

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
