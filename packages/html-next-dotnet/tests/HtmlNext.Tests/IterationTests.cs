using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class IterationTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "iterations.json")));
        foreach (var entry in document.RootElement.EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.TryGetProperty("native", out var native) ? native.GetString()! : entry.GetProperty("expected").GetString()!, entry.TryGetProperty("error", out var error) ? error.GetString()! : null!];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task RendersShapedRowsWithExplicitAliases(string name, string source, string expected, string? error)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        if (error is not null)
        {
            Assert.Contains(error, Assert.Throws<HtmlNextException>(() => template.Render()).Detail);
            using var output = new StringWriter();
            Assert.Contains(error, Assert.Throws<HtmlNextException>(() => template.Write(output)).Detail);
            return;
        }
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            Assert.Equal(expected, template.Render());
            using var writer = new StringWriter(); template.Write(writer);
            Assert.Equal(expected, writer.ToString());
        })));
    }

    [Theory]
    [InlineData("$loop")]
    [InlineData("$loop.index")]
    [InlineData("$index")]
    public void RejectsUndeclaredIterationNames(string expression)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("<template component=\"x-page\"><main><b $each=\"row of [1]\">{" + expression + "}</b></main></template>"));
    }

    [Theory]
    [InlineData("row, row of [1]")]
    public void RejectsAliasCollisions(string each)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("<template component=\"x-page\"><defs><state name=\"known\" type=\"number\" value=\"1\"></state></defs><main><b $each=\"" + each + "\"></b></main></template>"));
    }

    [Fact]
    public void RejectsCombinedStructuralDirectives()
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("<template component=\"x-page\"><main><b $each=\"row of [1]\" $if=\"true\"></b></main></template>"));
    }

    [Theory]
    [InlineData("$key", "1")]
    [InlineData("$sort", "row")]
    [InlineData("$limit", "1")]
    public void RejectsModifiersWithoutIteration(string name, string value)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("<template component=\"x-page\"><main " + name + "=\"" + value + "\"></main></template>"));
    }

    [Theory]
    [InlineData("field")]
    [InlineData("-other.id")]
    [InlineData("row.")]
    [InlineData("$$row")]
    public void RejectsSortKeysOutsideTheItemPath(string sort)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("<template component=\"x-page\"><main><b $each=\"row of [1]\" $sort=\"" + sort + "\"></b></main></template>"));
    }

    [Fact]
    public void DuplicateKeysFailAndDoNotPoisonLaterRenders()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-page"><defs><prop name="rows" type="list(number)">Rows.</prop></defs><main><b $each="row of $rows" $key="$row">{$row}</b></main></template>
            """);
        Assert.Contains("duplicate key", Assert.Throws<HtmlNextException>(() => template.Render(new { rows = new[] { 0d, -0d } })).Detail);
        Assert.Equal("<main><b>1</b><b>2</b></main>", template.Render(new { rows = new[] { 1, 2 } }));
        using var writer = new StringWriter();
        Assert.Throws<HtmlNextException>(() => template.Write(writer, new { rows = new[] { 1, 1 } }));
    }

    [Fact]
    public void SortingSnapshotsApplicationGettersOnceForEachOutputApi()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-page"><defs><prop name="rows" type="list(object({ n: number, name: string }))">Rows.</prop></defs><main><b $each="row, i of $rows" $sort="row.n" $limit="2" $key="$row.name" from:data-index="$i">{$row.name}</b></main></template>
            """);
        var rows = new[] { new CountingRow(2, "C"), new CountingRow(1, "B"), new CountingRow(1, "A") };
        const string expected = "<main><b data-index=\"0\">B</b><b data-index=\"1\">A</b></main>";
        Assert.Equal(expected, template.Render(new { rows }));
        Assert.All(rows, row => Assert.Equal(2, row.Reads));
        using var writer = new StringWriter(); template.Write(writer, new { rows });
        Assert.Equal(expected, writer.ToString());
        Assert.All(rows, row => Assert.Equal(4, row.Reads));
    }

    private sealed class CountingRow(double value, string label)
    {
        public int Reads;
        public double n { get { Reads++; return value; } }
        public string name { get { Reads++; return label; } }
    }
}
