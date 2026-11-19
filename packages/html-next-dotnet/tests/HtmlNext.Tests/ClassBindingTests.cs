using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ClassBindingTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "class-bindings.json")));
        foreach (var entry in document.RootElement.EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.TryGetProperty("native", out var native) ? native.GetString()! : entry.GetProperty("expected").GetString()!, entry.TryGetProperty("error", out var error) ? error.GetString()! : null!];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task RendersClassBindingsWithNativeTokenSemantics(string name, string source, string expected, string? error)
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

    [Fact]
    public async Task SnapshotsGettersAndKeepsRequestsIsolated()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-page"><defs><prop name="label" type="string">Label.</prop><prop name="active" type="boolean">Active.</prop></defs><main><b class="base" from:class="concat($label, ' base')" class:active="$active">{$label}</b></main></template>
            """);
        await Task.WhenAll(Enumerable.Range(0, 16).Select(index => Task.Run(() =>
        {
            var input = new CountingInput(index % 2 == 0, "row" + index);
            var expected = "<main><b class=\"row" + index + " base" + (index % 2 == 0 ? " active" : "") + "\">row" + index + "</b></main>";
            Assert.Equal(expected, template.Render(input));
            Assert.Equal(2, input.Reads);
            using var output = new StringWriter(); template.Write(output, input);
            Assert.Equal(expected, output.ToString());
            Assert.Equal(4, input.Reads);
        })));
    }

    [Theory]
    [InlineData("<b class:=\"true\"></b>")]
    [InlineData("<template class:active=\"true\"><b></b></template>")]
    [InlineData("<b $if=\"false\" class:active=\"$missing\"></b>")]
    public void ValidatesTargetsAndHiddenExpressions(string body)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.Compile("<template component=\"x-page\"><main>" + body + "</main></template>"));
    }

    private sealed class CountingInput(bool value, string text)
    {
        public int Reads;
        public string label { get { Reads++; return text; } }
        public bool active { get { Reads++; return value; } }
    }

}
