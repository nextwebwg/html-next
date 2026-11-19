using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class StructuredTypeTests
{
    private static CompiledTemplate Compile(string declaration, string body) => HtmlNextCompiler.Compile(
        "<template component=\"x-structured\"><defs>" + declaration + "</defs>" + body + "</template>", "structured.html");

    [Fact]
    public void PreservesOpenFieldsAndIteratesTheirUnknownLists()
    {
        var template = Compile("""
            <prop name="document" type="object({ type: string, ... })" default="{ type: 'doc', content: [{ text: 'Default' }] }">Document.</prop>
            """, "<ul><li $each=\"node of $document.content\">{$document.type}:{$node.text}</li></ul>");
        Assert.Equal("<ul><li>doc:Default</li></ul>", template.Render());
        Assert.Equal("<ul><li>note:A</li><li>note:B</li></ul>", template.Render(new { document = new { type = "note", content = new[] { new { text = "A" }, new { text = "B" } } } }));
        Assert.Equal("<ul></ul>", template.Render(new { document = new { type = "note" } }));
    }

    [Fact]
    public void OptionalFieldsMayBeAbsentWithoutInventingOwnProperties()
    {
        var template = Compile("""<prop name="value" type="object({ note?: string, })">Value.</prop>""",
            "<output>{$value ? 'present' : 'empty'}:{default($value.note, 'missing')}</output>");
        Assert.Equal("<output>empty:missing</output>", template.Render(new { value = new Dictionary<string, object?>() }));
        Assert.Equal("<output>present:Hello</output>", template.Render(new { value = new { note = "Hello" } }));
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<output>empty:missing</output>", template.Render(new { value = new { extra = "Wrong" } }, onDiagnostic: diagnostics.Add));
        Assert.Single(diagnostics);
    }

    [Fact]
    public void ReadsExpandedObjectAndListShapesWithNestedConstraints()
    {
        var template = Compile("""
            <prop name="rows" type="list" default="[{ id: 1, label: 'Ready' }]"><prop type="object" open>
              <prop name="id" type="integer" required min="1" max="3" values="1, 2, 3"></prop>
              <prop name="label" type="string" maxlength="10"></prop>
            </prop>Rows.</prop>
            """, "<ul><li $each=\"row of $rows\">{$row.id}:{default($row.label, 'none')}:{$row.extra}</li></ul>");
        Assert.Equal("<ul><li>1:Ready:</li></ul>", template.Render());
        Assert.Equal("<ul><li>2:none:Kept</li></ul>", template.Render(new { rows = new[] { new { id = 2, extra = "Kept" } } }));
        using var json = JsonDocument.Parse("{\"rows\":[{\"id\":3,\"label\":\"JSON\",\"extra\":\"Data\"}]}");
        Assert.Equal("<ul><li>3:JSON:Data</li></ul>", template.Render(json.RootElement));
        Assert.NotEmpty(template.Validate(new { rows = new[] { new { id = 9 } } }));
    }

    [Fact]
    public void UnknownFieldsKeepAliasesAndSnapshotGettersOnce()
    {
        var template = Compile("""
            <prop name="value" type="object" open>Value.</prop>
            """, "<output>{$value.a = $value.b}:{$value.a.label}:{$value.b.label}</output>");
        var shared = new CountingValue();
        Assert.Equal("<output>true:Once:Once</output>", template.Render(new { value = new { a = shared, b = shared } }));
        Assert.Equal(1, shared.Reads);
        Assert.Equal("<output>false:A:B</output>", template.Render(new { value = new { a = new { label = "A" }, b = new { label = "B" } } }));
    }

    [Fact]
    public void UnknownSnapshotsHandleCyclesWithoutConfusingTypedBoundaryIdentity()
    {
        var template = Compile("""
            <prop name="value" type="object" open><prop name="name" type="string" required></prop>Value.</prop>
            """, "<output>{$value = $value.self}:{$value.self = $value.self.self}:{$value.self.name}</output>");
        var value = new Dictionary<string, object?> { ["name"] = "Cycle" }; value["self"] = value;
        Assert.Equal("<output>false:true:Cycle</output>", template.Render(new { value }));
    }

    [Fact]
    public void SharesUnknownSnapshotsAcrossSeparateTypedPropBoundaries()
    {
        var template = Compile("""
            <prop name="left" type="object" open>Left.</prop>
            <prop name="right" type="object" open>Right.</prop>
            """, "<output>{$left = $right}:{$left.data = $right.data}:{$left.data.label}:{$right.data.label}</output>");
        var data = new CountingValue(); var boundary = new { data };
        Assert.Equal("<output>false:true:Once:Once</output>", template.Render(new { left = boundary, right = boundary }));
        Assert.Equal(1, data.Reads);
    }

    [Fact]
    public void BindsExpandedStateAndOptionalChildArguments()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-child"><defs><prop name="row" type="object({ id: number, label?: string })">Row.</prop></defs><b>{$row.id}:{default($row.label, 'none')}</b></template>
            <template component="x-parent"><defs><state name="rows" type="list" value="[{ id: 1 }, { id: 2, label: 'Two' }]"><prop type="object"><prop name="id" type="number" required></prop><prop name="label" type="string"></prop></prop></state></defs><div><x-child $each="row of $rows" from:row="$row"></x-child></div></template>
            """, "state.html");
        Assert.Equal("<div><b>1:none</b><b>2:Two</b></div>", graph.Template("x-parent").Render());
    }

    [Fact]
    public void OpenObjectStillRejectsArraysAndScalars()
    {
        var template = Compile("""<prop name="value" type="object" open>Value.</prop>""", "<output>{$value ? 'present' : 'empty'}</output>");
        foreach (var value in new object[] { new[] { 1, 2 }, 3m, true, "text" })
        {
            var errors = new List<HtmlNextDiagnostic>();
            Assert.Equal("<output>empty</output>", template.Render(new { value }, onDiagnostic: errors.Add));
            Assert.Single(errors);
        }
    }

    [Fact]
    public void RequiredUnknownFieldsMustBePresentEvenWhenTheirTypeAcceptsNull()
    {
        Assert.Throws<HtmlNextException>(() => Compile("""<state name="value" type="object({ data: unknown })" value="{}"></state>""", "<output></output>"));
        var template = Compile("""<state name="value" type="object({ data: unknown })" value="{ data: null }"></state>""", "<output>{$value ? 'present' : 'empty'}</output>");
        Assert.Equal("<output>present</output>", template.Render());
    }

    [Fact]
    public void CancelsUnknownEnumerationAndSurfacesApplicationGetterFailures()
    {
        var template = Compile("""<prop name="value" type="object" open>Value.</prop>""", "<output>{$value.data.label}</output>");
        using var cancellation = new CancellationTokenSource();
        var input = new { value = new { data = CancelWhileEnumerating(cancellation) } };
        Assert.Throws<OperationCanceledException>(() => template.Render(input, cancellation.Token));
        var failure = Assert.Throws<HtmlNextException>(() => template.Render(new { value = new { data = new ThrowingValue() } }));
        Assert.Equal("HNCS002", failure.Code);
        Assert.Equal("structured.html", failure.SourceName);
    }

    private static IEnumerable<object> CancelWhileEnumerating(CancellationTokenSource cancellation)
    {
        yield return new { label = "First" };
        cancellation.Cancel();
        yield return new { label = "Second" };
    }

    private sealed class ThrowingValue { public string label => throw new InvalidOperationException("Application failure"); }

    [Theory]
    [InlineData("<prop name='value' type='list'>Value.</prop>")]
    [InlineData("<prop name='value' type='list'><prop name='item' type='string'></prop>Value.</prop>")]
    [InlineData("<prop name='value' type='number'><prop name='x' type='number'></prop>Value.</prop>")]
    [InlineData("<prop name='value' type='object'><prop name='x' type='number'></prop><prop name='x' type='string'></prop>Value.</prop>")]
    [InlineData("<prop name='value' type='object({ x: number, ..., y: number })'>Value.</prop>")]
    [InlineData("<prop name='value' type='object'><prop name='x' type='integer' required values='bad'></prop>Value.</prop>")]
    [InlineData("<prop name='value' type='unknown'>Value.</prop>")]
    [InlineData("<prop name='value' type='object({ data: unknown })'>Value.</prop>")]
    public void RejectsMalformedShapes(string declaration) => Assert.Throws<HtmlNextException>(() => Compile(declaration, "<output></output>"));

    private sealed class CountingValue
    {
        public int Reads;
        public string label { get { Reads++; return "Once"; } }
    }
}
