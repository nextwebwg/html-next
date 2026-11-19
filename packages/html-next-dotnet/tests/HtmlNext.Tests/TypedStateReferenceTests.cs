using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class TypedStateReferenceTests
{
    private static CompiledTemplate Compile(string declarations, string body) => HtmlNextCompiler.Compile(
        "<template component=\"x-typed-seed\"><defs>" + declarations + "</defs>" + body + "</template>", "typed-seed.html");

    [Fact]
    public void AcceptsStructuredSeedsAndChecksEachTypedRead()
    {
        var template = Compile("""
            <state name="draft" type="object({ name: string, id: number })" from="{ name: 2, id: 5 }"></state>
            <computed name="label" from="$draft.name"></computed>
            <computed name="id" from="$draft.id + 1"></computed>
            """, "<output>{$draft.name}:{$draft.id}:{default($draft.name, 'fallback')}:{$label}:{$id}</output>");
        const string expected = "<output>:5:::6</output>";
        Assert.Equal(expected, template.Render());
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(expected, writer.ToString());
    }

    [Fact]
    public void ChecksIntermediateKindsAndComputedKeysWithoutDiscardingSiblings()
    {
        var template = Compile("""
            <state name="draft" type="object({ nested: object({ name: string }), id: number })" from="{ nested: 2, id: 5 }"></state>
            <prop name="key" type="string" default="nested">Key.</prop>
            """, "<output>{default($draft.nested.name, 'fallback')}:{default($draft[$key].name, 'fallback')}:{$draft.id}</output>");
        Assert.Equal("<output>fallback:fallback:5</output>", template.Render());
    }

    [Fact]
    public void PreservesMissingNullAndExtraFieldsInSeededRecords()
    {
        var template = Compile("""
            <state name="missing" type="object({ name: string, id: number })" from="{ id: 5, extra: 'kept' }"></state>
            <state name="draft" type="object({ name: string, id: number })" from="{ name: null, id: 5 }"></state>
            """, "<output>{default($missing.name, 'fallback')}:{$missing.id}:{$draft.name = null}:{$draft.id}</output>");
        Assert.Equal("<output>fallback:5:true:5</output>", template.Render());
    }

    [Theory]
    [InlineData("$partial.count + 1", "")]
    [InlineData("$draft.count + 1", "")]
    [InlineData("$partial.name ^= 'A'", "")]
    [InlineData("$draft.name ^= 'A'", "")]
    [InlineData("$partial ? 'yes' : 'no'", "no")]
    [InlineData("true and $draft.flag", "false")]
    [InlineData("$partial.count = null", "")]
    [InlineData("$partial.count != null", "")]
    [InlineData("$partial.count = $partial.count", "")]
    [InlineData("not ($partial.count = $partial.count)", "true")]
    [InlineData("$draft.count = null", "true")]
    [InlineData("($partial.count = null) = false", "")]
    [InlineData("default($partial.count = null, true)", "true")]
    public void KeepsMissingAndNullSeedFieldsAbsentInOperators(string expression, string expected)
    {
        var template = Compile("""
            <state name="partial" type="object({ name: string, count: number, flag: boolean })" from="{}"></state>
            <state name="draft" type="object({ name: string, count: number, flag: boolean })" from="{ name: null, count: null, flag: null }"></state>
            """, "<output>{" + expression + "}</output>");
        Assert.Equal("<output>" + expected + "</output>", template.Render());
    }

    [Fact]
    public void ChecksEachListItemThroughAliasesAndDirectPaths()
    {
        var template = Compile("""
            <state name="rows" type="list(object({ name: string, id: number }))" from="[{ name: 2, id: 1 }, 4, { name: 'A', id: 3 }]"></state>
            """, "<output><b $each=\"row of $rows\">{default($row.name, 'fallback')}:{$row.id};</b>{default($rows.1.name, 'fallback')}</output>");
        Assert.Equal("<output><b>:1;</b><b>fallback:;</b><b>A:3;</b>fallback</output>", template.Render());
    }

    [Fact]
    public void KeepsNestedSourceLayoutsThroughTypedAndComputedPaths()
    {
        var template = Compile("""
            <prop name="source" type="object({ nested: object({ id: number, name: string }) })">Source.</prop>
            <prop name="key" type="string" default="nested">Key.</prop>
            <state name="draft" type="object({ nested: object({ name: string, id: number }) })" from="$source"></state>
            """, "<output>{$draft.nested.name}:{$draft[$key].name}:{$draft.nested.id}</output>");
        Assert.Equal("<output>A:A:2</output>", template.Render(new { source = new { nested = new { id = 2, name = "A" } } }));
    }

    [Fact]
    public void ValueConstraintsDoNotRefuseCorrectlyTypedSeedFields()
    {
        var template = Compile("""
            <state name="draft" type="object" from="{ name: 'A', id: 5 }"><prop name="name" type="string" required></prop><prop name="id" type="number" min="10"></prop></state>
            """, "<output>{$draft.name}:{$draft.id}</output>");
        Assert.Equal("<output>A:5</output>", template.Render());
    }

    [Fact]
    public void CopiesTypedSeedGraphsWithoutBreakingSharedChildIdentity()
    {
        var template = Compile("""
            <prop name="source" type="object" open>Source.</prop>
            <state name="draft" type="object({ left: object({ name: string }), right: object({ name: string }) })" from="$source.value"></state>
            """, "<output>{$draft = $source.value}:{$draft.left = $draft.right}:{$draft.left.name}:{$draft.right.name}</output>");
        var shared = new { name = "A" };
        Assert.Equal("<output>false:true:A:A</output>", template.Render(new { source = new { value = new { left = shared, right = shared } } }));
    }
}
