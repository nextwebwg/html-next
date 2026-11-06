using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class InvocationAttributeTests
{
    [Fact]
    public void PreservesNonAsciiPropCaseThroughDelegatedAttributes()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-leaf"><defs><prop name="é" type="string">Lower.</prop><prop name="É" type="string">Upper.</prop></defs><b>{$é}:{$É}</b></template>
            <template component="x-wrap"><x-leaf></x-leaf></template>
            <template component="x-page"><main><x-wrap é="lower" É="upper"></x-wrap></main></template>
            """).Template("x-page");
        Assert.Equal("<main><b>lower:upper</b></main>", template.Render());
    }

    [Fact]
    public async Task SnapshotsForwardedCallerDataOnceAndIsolatesConcurrentRenders()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-leaf"><b>Leaf</b></template>
            <template component="x-page"><defs><prop name="row" type="object({ label: string, id: integer })">Row.</prop></defs><main><x-leaf from:title="$row.label" from:data-id="$row.id"></x-leaf></main></template>
            """).Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 16).Select(index => Task.Run(() =>
        {
            var row = new CountingRow(index);
            var expected = $"<main><b title=\"Row {index}\" data-id=\"{index}\">Leaf</b></main>";
            Assert.Equal(expected, template.Render(new { row }));
            Assert.Equal(2, row.Reads);
            using var writer = new StringWriter(); template.Write(writer, new { row });
            Assert.Equal(expected, writer.ToString());
            Assert.Equal(4, row.Reads);
        })));
    }

    private sealed class CountingRow(int index)
    {
        public int Reads;
        public string label { get { Reads++; return "Row " + index; } }
        public int id { get { Reads++; return index; } }
    }

    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "invocation-attributes.json")));
        foreach (var entry in document.RootElement.EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, (entry.TryGetProperty("native", out var native) ? native : entry.GetProperty("expected")).GetString()!];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task ForwardsCallerAttributesThroughNativeRoots(string name, string source, string expected)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            Assert.Equal(expected, template.Render());
            using var writer = new StringWriter(); template.Write(writer);
            Assert.Equal(expected, writer.ToString());
        })));
    }
}
