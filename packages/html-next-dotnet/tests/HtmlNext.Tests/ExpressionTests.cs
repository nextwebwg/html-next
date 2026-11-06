using System.Globalization;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ExpressionTests
{
    private static CompiledTemplate Text(string expression, string declarations = "") => HtmlNextCompiler.Compile(
        "<template component=\"x-expression\"><defs>" + declarations + "</defs><output>{" + Html(expression) + "}</output></template>", "expressions.html");
    private static string Html(string value) => value.Replace("&", "&amp;", StringComparison.Ordinal).Replace("<", "&lt;", StringComparison.Ordinal);
    private const string Props = """
        <prop name="a" type="number">First.</prop><prop name="b" type="number">Second.</prop>
        <prop name="label" type="string">Label.</prop><prop name="enabled" type="boolean">Enabled.</prop>
        <prop name="index" type="number">Index.</prop><prop name="items" type="list(object({id: number, name: string}))">Rows.</prop>
        """;

    [Theory]
    [InlineData("0.1 + 0.2", "0.3")]
    [InlineData("1.1 - 0.1", "1")]
    [InlineData("0.1 * 0.2", "0.02")]
    [InlineData("0.3 % 0.1", "0")]
    [InlineData("1 / 3", "0.3333333333333333")]
    [InlineData("2 + 3 * 4", "14")]
    [InlineData("(2 + 3) * 4", "20")]
    [InlineData("1e-7 + 1e-7", "2e-7")]
    [InlineData("-2.5 * -2", "5")]
    [InlineData("not false and (false or 4)", "true")]
    [InlineData("0 or 'value'", "true")]
    [InlineData("'' and 'other'", "false")]
    [InlineData("'begin' ^= 'be'", "true")]
    [InlineData("'ending' $= 'ing'", "true")]
    [InlineData("'middle' *= 'idd'", "true")]
    [InlineData("1 != 2 and 1 <= 2 and 3 > 2", "true")]
    [InlineData("default(null, 'fallback')", "fallback")]
    [InlineData("default(0, 8)", "0")]
    [InlineData("default(false, true)", "false")]
    [InlineData("default('', 'fallback')", "")]
    [InlineData("true ? 1 : (1 / 0)", "1")]
    [InlineData("default(5, 1 / 0)", "5")]
    [InlineData("false ? 1 : true ? 2 : 3", "2")]
    [InlineData("round(-2.5)", "-2")]
    [InlineData("round(8.8, 2)", "8")]
    [InlineData("clamp(10, 5, 2)", "10")]
    [InlineData("min(4, -1, 8)", "-1")]
    [InlineData("max(4, -1, 8)", "8")]
    [InlineData("abs(-4)", "4")]
    [InlineData("join(['a', null, 'b'], ', ')", "a, , b")]
    [InlineData("join([], ', ')", "")]
    [InlineData("concat('A', true, 0, null, '<B>')", "Atrue0&lt;B&gt;")]
    [InlineData("concat('A', concat(1 / 0))", "")]
    [InlineData("join([concat(1 / 0)], '')", "")]
    [InlineData("false ? concat(1 / 0) : 'kept'", "kept")]
    [InlineData("[{ 'first-name': 'Ada' }][0]['first-name']", "Ada")]
    [InlineData("{ '9007199254740993': 'exact' }[9007199254740993]", "exact")]
    [InlineData("{ '9007199254740993': 'exact' }.9007199254740993", "exact")]
    [InlineData("{ '00': 'exact' }[00]", "exact")]
    [InlineData("{ a: 1, a: 2 }.a", "2")]
    [InlineData("{ text: '}' }.text", "}")]
    [InlineData("not [] and not {} and { present: null }", "true")]
    [InlineData("'👋'.length", "2")]
    [InlineData("round(8.8px)", "9px")]
    [InlineData("2.5 * 100px", "250px")]
    [InlineData("100px / 4 + 2px", "27px")]
    [InlineData("max(200ms, 500ms)", "500ms")]
    [InlineData("abs(-2rem)", "2rem")]
    [InlineData("round(25.5%)", "26%")]
    [InlineData("1.0px", "1.0px")]
    [InlineData("not 0px", "false")]
    [InlineData("solid = 'solid'", "true")]
    public void EvaluatesPureExpressionsAndWritesEquivalentStringsAndStreams(string expression, string expected)
    {
        var compiled = Text(expression);
        using var writer = new StringWriter(CultureInfo.InvariantCulture);
        compiled.Write(writer);
        Assert.Equal("<output>" + expected + "</output>", compiled.Render());
        Assert.Equal(compiled.Render(), writer.ToString());
    }

    [Fact]
    public void BindsOperatorsAndDynamicIndicesOnceWithoutAmbientFunctions()
    {
        var compiled = Text("concat($label, ':', $a * $b, ':', $items[$index].name, ':', $items.length)", Props);
        Assert.Equal("<output>A:0.3:second:2</output>", compiled.Render(new
        {
            label = "A", a = 0.1, b = 3, index = 1, items = new[] { new { id = 1, name = "first" }, new { id = 2, name = "second" } },
        }));
        Assert.Equal("<output>B:6:first:1</output>", compiled.Render(new
        {
            label = "B", a = 2, b = 3, index = 0, items = new[] { new { id = 9, name = "first" } },
        }));
    }

    [Fact]
    public void DistinguishesSafeMissingReadsFromNullAndDoesNotCoerce()
    {
        Assert.Equal("<output>fallback</output>", Text("default($items[8].name, 'fallback')", Props).Render(new { items = Array.Empty<object>() }));
        Assert.Equal("<output></output>", Text("$items[8].name = null", Props).Render(new { items = Array.Empty<object>() }));
        Assert.Equal("<output>true</output>", Text("$label = null", Props).Render());
        Assert.Equal("<output></output>", Text("$a / $b", Props).Render(new { a = 1, b = 0 }));
    }

    [Fact]
    public void UsesWhereForPerRowGuardsInInertListRendering()
    {
        var compiled = HtmlNextCompiler.Compile("""
            <template component="x-array"><div><b $each="row of [{ name: 'A', show: true }, { name: 'B', show: false }]" $where="$row.show">{$row.name}</b></div></template>
            """);
        Assert.Equal("<div><b>A</b></div>", compiled.Render());
    }

    [Fact]
    public void PreservesActualRecordLayoutsAcrossCompatibleConditionalAndListValues()
    {
        var compiled = HtmlNextCompiler.Compile("""
            <template component="x-records"><div><b $each="row of [{ name: 'A', id: 1 }, { id: 2, name: 'B' }]">{$row.name}:{$row.id}</b></div></template>
            """);
        Assert.Equal("<div><b>A:1</b><b>B:2</b></div>", compiled.Render());
    }

    [Fact]
    public void AcceptsStructuredDefaultsAndUnicodeAndExactQuotedKeys()
    {
        var declarations = """
            <prop name="résumé" type="string" default="Ready">Title.</prop>
            <prop name="rows" type="list(object({ '9007199254740993': string, id: integer }))" default="[{ '9007199254740993': 'A', id: 1 }]">Rows.</prop>
            """;
        var compiled = Text("concat($résumé, ':', $rows[0][9007199254740993], ':', $rows[0].id)", declarations);
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<output>Ready:A:1</output>", compiled.Render(onDiagnostic: diagnostics.Add));
        Assert.Empty(diagnostics);
        using var writer = new StringWriter(CultureInfo.InvariantCulture);
        compiled.Write(writer, onDiagnostic: diagnostics.Add);
        Assert.Equal("<output>Ready:A:1</output>", writer.ToString());
        Assert.Empty(diagnostics);
        Assert.Equal("<output>Ready:A:1</output>", compiled.Render(new { rows = 42 }, onDiagnostic: diagnostics.Add));
        Assert.Equal("HNCS004", Assert.Single(diagnostics).Code);
    }

    [Fact]
    public void ReadsTypedDimensionsAndDoesNotProduceResultsForIncompatibleUnits()
    {
        const string declarations = """
            <prop name="width" type="length">Width.</prop><prop name="gap" type="length">Gap.</prop>
            """;
        var compiled = Text("$width / 4 + $gap", declarations);
        Assert.Equal("<output>27px</output>", compiled.Render(new { width = "100px", gap = "2px" }));
        Assert.Equal("<output></output>", compiled.Render(new { width = "100rem", gap = "2px" }));
        Assert.Equal("<output>32px</output>", compiled.Render(new { width = "120px", gap = "2px" }));
    }

    [Fact]
    public void RejectsExtraClosedObjectMembersWithoutReadingTheirGetters()
    {
        const string declarations = """
            <prop name="record" type="object({ name: string })">Record.</prop>
            """;
        var diagnostics = new List<HtmlNextDiagnostic>();
        var compiled = Text("$record.name", declarations);
        Assert.Equal("<output></output>", compiled.Render(new { record = new ExtraRecord() }, onDiagnostic: diagnostics.Add));
        Assert.Contains("undeclared field", Assert.Single(diagnostics).Message);
        Assert.Equal("<output>Valid</output>", compiled.Render(new { record = new { name = "Valid" } }));
    }

    [Fact]
    public void ReportsNestedGetterFailuresWithTheirSourceAndRetainsCancellation()
    {
        var compiled = Text("$record.name", """<prop name="record" type="object({ name: string })">Record.</prop>""");
        var error = Assert.Throws<HtmlNextException>(() => compiled.Render(new { record = new BrokenRecord() }));
        Assert.Equal("expressions.html", error.SourceName);
        Assert.Equal("HNCS002", error.Code);
        Assert.IsType<InvalidOperationException>(error.InnerException);
    }

    [Fact]
    public void RequiresLiteralDefaultsEvenWhenAnExpressionCouldBeFolded()
    {
        Assert.Throws<HtmlNextException>(() => Text("$items.length", """<prop name="items" type="list(number)" default="[1 + 2]">Items.</prop>"""));
    }

    [Fact]
    public void ReadsValueTypedDictionariesAndPreservesDefaultArraysBetweenRequests()
    {
        var compiled = Text("$a * $b", Props);
        Assert.Equal("<output>6</output>", compiled.Render(new Dictionary<string, int> { ["a"] = 2, ["b"] = 3 }));
        var defaults = Text("$items[0].id", """<prop name="items" type="list(object({ id: integer }))" default="[{ id: 7 }]">Items.</prop>""");
        Assert.Equal("<output>7</output>", defaults.Render());
        Assert.Equal("<output>9</output>", defaults.Render(new { items = new[] { new { id = 9 } } }));
        Assert.Equal("<output>7</output>", defaults.Render());
    }

    [Fact]
    public async Task KeepsExpressionScratchAndOrderedModelReadersIsolatedAcrossRequests()
    {
        var compiled = Text("concat($label, ':', concat($a * $b, ':', join([$label, 'end'], ',')))", Props);
        var outputs = await Task.WhenAll(Enumerable.Range(1, 100).Select(index => Task.Run(() =>
            compiled.Render(new { a = index, b = 3, label = index.ToString(CultureInfo.InvariantCulture) }))));
        for (var index = 1; index <= outputs.Length; index++) Assert.Equal($"<output>{index}:{index * 3}:{index},end</output>", outputs[index - 1]);
    }

    private sealed class ExtraRecord
    {
        public string name => "Valid";
        public string extra => throw new InvalidOperationException("Must not be read.");
    }
    private sealed class BrokenRecord { public string name => throw new InvalidOperationException("Getter failed."); }

    [Theory]
    [InlineData("$missing")]
    [InlineData("true ? 1 : $missing")]
    [InlineData("1 + '2'")]
    [InlineData("1 = '1'")]
    [InlineData("concat({ a: 1 })")]
    [InlineData("join([{}], ',')")]
    [InlineData("abs()")]
    [InlineData("unknown(1)")]
    [InlineData("$label.toString()")]
    [InlineData("window.alert('x')")]
    [InlineData("nottrue()")]
    [InlineData("1px + 1ms")]
    [InlineData("1px * 1px")]
    [InlineData("1px % 2")]
    [InlineData("$a = 2; $b")]
    [InlineData("$a | escape")]
    [InlineData("'unclosed")]
    public void RejectsAuthorErrorsAndJavascriptSyntaxAtCompilation(string expression)
    {
        var error = Assert.Throws<HtmlNextException>(() => Text(expression, Props));
        Assert.Equal("expressions.html", error.SourceName);
    }
}
