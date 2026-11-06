using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class StructuralRenderingTests
{
    private static CompiledTemplate Compile(string body, string props = "") => HtmlNextCompiler.Compile(
        "<template component=\"x-flow\"><defs>" + props + "</defs>" + body + "</template>", "flow.html");

    private static void Output(CompiledTemplate template, string expected, object? data = null)
    {
        Assert.Equal(expected, template.Render(data));
        using var writer = new StringWriter();
        template.Write(writer, data);
        Assert.Equal(expected, writer.ToString());
    }

    [Fact]
    public void WithBindsOnlyChildrenAndShadowsLexically()
    {
        var template = Compile("""
            <div><section from:title="$label" $with="'inner' as label"><b>{$label}</b><template $with="'nested' as label"><i>{$label}</i></template><b>{$label}</b></section><p>{$label}</p></div>
            """, "<prop name=\"label\" type=\"string\">Label.</prop>");
        Output(template, "<div><section title=\"outer\"><b>inner</b><i>nested</i><b>inner</b></section><p>outer</p></div>", new { label = "outer" });
    }

    [Fact]
    public void WrapperFreeTemplatesPreserveTableRowsAndEscapedValue()
    {
        var template = Compile("""
            <table><tbody><template $each="row of [1, 2]"><tr><td>{$row}</td></tr><tr><td><template $value="'&lt;safe&gt;'"></template></td></tr></template><template $if="false"><tr><td>Hidden</td></tr></template></tbody></table>
            """);
        Output(template, "<table><tbody><tr><td>1</td></tr><tr><td>&lt;safe&gt;</td></tr><tr><td>2</td></tr><tr><td>&lt;safe&gt;</td></tr></tbody></table>");
    }

    [Theory]
    [InlineData("pro", "<section><b>3</b></section>")]
    [InlineData("free", "<section><i>Free</i></section>")]
    public void MatchSelectsFirstArmWithScopedSubject(string tier, string expected)
    {
        var template = Compile("""
            <section $match="$plan as current"><b $when="$current.tier = 'pro'">{$current.seats}</b><strong $when="true and $current.tier = 'pro'">Later</strong><template $else><i>Free</i></template></section>
            """, "<prop name=\"plan\" type=\"object({ tier: string, seats: number })\">Plan.</prop>");
        Output(template, expected, new { plan = new { tier, seats = 3 } });
    }

    [Fact]
    public void BareMatchAndNativeRootSelectionRenderOnlyTheWinningArm()
    {
        var template = Compile("""
            <template $match><a $when="$link" href="/docs">Docs</a><button $else>Docs</button></template>
            """, "<prop name=\"link\" type=\"boolean\">Link mode.</prop>");
        Output(template, "<a href=\"/docs\">Docs</a>", new { link = true });
        Output(template, "<button>Docs</button>", new { link = false });
        Output(Compile("<div><template $match=\" \"><b $when=\"false\">Hidden</b></template></div>"), "<div></div>");
    }

    [Fact]
    public void WholeIterationGuardUsesOuterScopeAndWhereFiltersItems()
    {
        var template = Compile("""
            <div><b $each="row of [1, 2, 3]" $if="$row" $where="$row > 1">{$row}</b><i>{$row}</i></div>
            """, "<prop name=\"row\" type=\"boolean\">Whole-list guard.</prop>");
        Output(template, "<div><b>2</b><b>3</b><i>true</i></div>", new { row = true });
        Output(template, "<div><i>false</i></div>", new { row = false });
    }

    [Fact]
    public void TextEscapesAreAppliedOnlyToAuthoredText()
    {
        var template = Compile("""
            <p>\{literal} \\ {$label} \q \$label <template $value="$label"></template></p>
            """, "<prop name=\"label\" type=\"string\">Label.</prop>");
        Output(template, "<p>{literal} \\ \\{data} \\q \\$label \\{data}</p>", new { label = "\\{data}" });
    }

    [Fact]
    public void AbsentScopedFieldsRemoveBoundAttributes()
    {
        var template = Compile("<div><template $with=\"$items[8] as row\"><b from:title=\"$row.name\">Empty</b></template></div>",
            "<prop name=\"items\" type=\"list(object({ name: string }))\">Rows.</prop>");
        Output(template, "<div><b>Empty</b></div>", new { items = Array.Empty<object>() });
    }

    [Fact]
    public async Task CachedScopesAreIsolatedAcrossConcurrentRenders()
    {
        var template = Compile("""
            <div><template $with="$label as current"><b>{$current}</b><template $match><i $when="$current = 'A'">First</i><i $else>Other</i></template></template></div>
            """, "<prop name=\"label\" type=\"string\">Label.</prop>");
        await Task.WhenAll(Enumerable.Range(0, 32).Select(index => Task.Run(() =>
        {
            var label = index % 2 == 0 ? "A" : "B";
            var arm = label == "A" ? "First" : "Other";
            Output(template, "<div><b>" + label + "</b><i>" + arm + "</i></div>", new { label });
        })));
    }

    [Fact]
    public void StaticallyChecksHiddenMatchArmsAndUsesRecordLayoutsFromTheSelectedValue()
    {
        Assert.Throws<HtmlNextException>(() => Compile("<div $match><b $when=\"true\">Ready</b><i $else>{$missing}</i></div>"));
        Output(Compile("<div $with=\"false ? { name: 'A', id: 1 } : { id: 2, name: 'B' } as row\"><b>{$row.name}:{$row.id}</b></div>"),
            "<div><b>B:2</b></div>");
    }

    [Theory]
    [InlineData("<div><i $when=\"true\"></i></div>")]
    [InlineData("<div><i $else></i></div>")]
    [InlineData("<div $match><b></b></div>")]
    [InlineData("<div $match>unexpected<b $when=\"true\"></b></div>")]
    [InlineData("<div $match><b $else></b><i $when=\"true\"></i></div>")]
    [InlineData("<div $match><b $else></b><i $else></i></div>")]
    [InlineData("<div $with=\"1\"></div>")]
    [InlineData("<div $with=\"1 as one\" from:title=\"$one\"></div>")]
    [InlineData("<div><template $with=\"1 as one\"><b>{$one}</b></template><i>{$one}</i></div>")]
    [InlineData("<div><b $where=\"true\"></b></div>")]
    [InlineData("<template $match><b $when=\"true\"></b></template>")]
    [InlineData("<template $if=\"true\"><b></b></template>")]
    [InlineData("<div><template class=\"lost\"><b></b></template></div>")]
    public void RejectsMalformedScopesArmsAndFragments(string body)
    {
        var error = Assert.Throws<HtmlNextException>(() => Compile(body));
        Assert.Equal("flow.html", error.SourceName);
    }
}
