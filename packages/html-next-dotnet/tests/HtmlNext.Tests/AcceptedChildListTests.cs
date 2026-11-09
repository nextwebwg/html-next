using System.Text.Json;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class AcceptedChildListTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "accepted-child-lists.json")));
        foreach (var entry in document.RootElement.EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty("expected").GetString()!];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task ReadsAcceptedChildListsAndProjectsTheirSlots(string name, string source, string expected)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            var html = template.Render();
            using var writer = new StringWriter();
            template.Write(writer);
            Assert.Equal(html, writer.ToString());
            using var document = new HtmlParser().ParseDocument(html);
            var root = document.Body!.FirstElementChild!;
            foreach (var carrier in root.QuerySelectorAll("template[carrier]")) carrier.Remove();
            RemoveMarks(root);
            Assert.Equal(expected, root.OuterHtml);
        })));
    }

    public static IEnumerable<object[]> EntryExpressions()
    {
        static string Outlet(string expression) => $"<slot of=\"{expression}\" name=\"cell\" text=\"7\"><em>Empty</em></slot>";
        yield return [Outlet("$columns[$position]"), "", false, "C:7:true"];
        yield return [Outlet("$chosen"), "<computed name=\"chosen\" from=\"$columns[$position]\"></computed>", false, "C:7:true"];
        yield return [$"<template $with=\"$columns[1] as chosen\">{Outlet("$chosen")}</template>", "", false, "C:7:true"];
        yield return [$"<template $match=\"$columns[1] as chosen\"><template $when=\"true\">{Outlet("$chosen")}</template></template>", "", false, "C:7:true"];
        foreach (var choose in new[] { false, true })
        {
            yield return [Outlet("$chosen"), "<computed name=\"chosen\" from=\"$choose ? $columns[1] : $actions[0]\"></computed>", choose, choose ? "C:7:true" : "A:7:8"];
            yield return [$"<template $each=\"entry of $chosen\">{Outlet("$entry")}</template>", "<computed name=\"chosen\" from=\"$choose ? $columns : $actions\"></computed>", choose, choose ? "C:7:trueC:7:true" : "A:7:8"];
        }
        yield return [$"<template $each=\"columns of $columns\">{Outlet("$columns")}</template>", "", false, "C:7:trueC:7:true"];
        yield return [$"<template $each=\"entry of [$columns[1], null, $actions[0]]\">{Outlet("$entry")}</template>", "", false, "C:7:true<em>Empty</em>A:7:8"];
        yield return [Outlet("$columns[99]"), "", false, "<em>Empty</em>"];
        yield return [Outlet("null"), "", false, "<em>Empty</em>"];
        yield return [Outlet("default($columns[99], $actions[0])"), "", false, "A:7:8"];
    }

    [Theory]
    [MemberData(nameof(EntryExpressions))]
    public void PreservesEntryIdentityThroughExpressions(string body, string declarations, bool choose, string expected)
    {
        var source = """
            <template component="x-column"><defs><slot name="cell"><prop name="text" type="string">Cell text.</prop></slot></defs><span>Column</span></template>
            <template component="x-action"><defs><slot name="cell"><prop name="text" type="integer">Cell number.</prop></slot></defs><span>Action</span></template>
            <template component="x-list"><defs><prop name="choose" type="boolean" default="false">Choose columns.</prop><prop name="position" type="integer" default="1">Index.</prop>
            <slot accepts="x-column" as="columns"></slot><slot name="actions" accepts="x-action" as="actions"></slot>
            """ + declarations + "</defs><section>" + body + "</section></template>" +
            $"<template component=\"x-page\"><main><x-list choose=\"{choose.ToString().ToLowerInvariant()}\">" + """
            <x-column><template slot="cell">C:{$text}:{$text = '7'}</template></x-column>
            <x-column><template slot="cell">C:{$text}:{$text = '7'}</template></x-column>
            <x-action slot="actions"><template slot="cell">A:{$text}:{$text + 1}</template></x-action></x-list></main></template>
            """;
        var template = HtmlNextCompiler.CompileResource(source).Template("x-page");
        var html = template.Render();
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(html, writer.ToString());
        using var document = new HtmlParser().ParseDocument(html);
        var root = document.Body!.FirstElementChild!;
        foreach (var carrier in root.QuerySelectorAll("template[carrier]")) carrier.Remove();
        RemoveMarks(root);
        Assert.Equal("<main><section>" + expected + "</section></main>", root.OuterHtml);
    }

    [Theory]
    [InlineData("$choose ? $columns[0] : {}")]
    [InlineData("[$columns[0], {}][1]")]
    [InlineData("($choose ? $columns : [{}])[0]")]
    public void ACompatibleCopiedRecordDoesNotAcquireEntryProvenance(string expression)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource("""
            <template component="x-column"><defs><slot name="cell"></slot></defs><span></span></template>
            <template component="x-page"><defs><prop name="choose" type="boolean">Choice.</prop><slot accepts="x-column" as="columns"></slot></defs>
            """ + $"<main><slot of=\"{expression}\" name=\"cell\"></slot></main></template>"));
    }

    [Fact]
    public void AConstantNullOutletNeedsNoAcceptedList()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-page"><main><slot of="null" name="cell">Empty</slot></main></template>
            """).Template("x-page");
        Assert.Contains(">Empty<", template.Render());
    }

    [Theory]
    [InlineData("<slot as=\"columns\"></slot>")]
    [InlineData("<slot accepts=\"x-column\" as=\"\"></slot>")]
    [InlineData("<slot accepts=\"x-column\" as=\"columns\"></slot><prop name=\"columns\" type=\"string\">Collision.</prop>")]
    [InlineData("<slot accepts=\"x-column\" as=\"columns\"></slot><state name=\"columns\" type=\"integer\" value=\"0\"></state>")]
    [InlineData("<slot accepts=\"x-column\" as=\"columns\"></slot><slot name=\"other\" accepts=\"x-column\" as=\"columns\"></slot>")]
    public void RejectsAnUntypedListOrADeclarationCollision(string declarations)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(
            "<template component=\"x-column\"><b>Column</b></template><template component=\"x-list\"><defs>" + declarations + "</defs><ul></ul></template>"));
    }

    [Fact]
    public void CollectingSortedEntriesSnapshotsGettersOnceForEachOutputApi()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-column"><defs><prop name="header" type="string">Heading.</prop><slot name="cell"><prop name="item" type="string">Item.</prop></slot></defs><b><slot name="cell"></slot></b></template>
            <template component="x-list"><defs><slot accepts="x-column" as="columns"></slot></defs><ul><li $each="column of $columns">{$column.header}<slot of="$column" name="cell" from:item="'Row'"></slot></li></ul></template>
            <template component="x-page"><defs><prop name="rows" type="list(object({ n: number, name: string }))">Rows.</prop></defs><main><x-list><x-column $each="row, position of $rows" $sort="row.n" $limit="2" from:header="$row.name"><template slot="cell">{$item}:{$row.name}:{$position}</template></x-column></x-list></main></template>
            """).Template("x-page");
        var rows = new[] { new CountingRow(2, "C"), new CountingRow(1, "B"), new CountingRow(1, "A") };
        var html = template.Render(new { rows });
        Assert.All(rows, row => Assert.Equal(2, row.Reads));
        using (var document = new HtmlParser().ParseDocument(html)) Assert.Equal("BRow:B:0ARow:A:1", document.QuerySelector("ul")!.TextContent);
        using var writer = new StringWriter(); template.Write(writer, new { rows });
        Assert.Equal(html, writer.ToString());
        Assert.All(rows, row => Assert.Equal(4, row.Reads));
    }

    [Fact]
    public void CollectingEntriesRejectsDuplicateAuthoredKeys()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-column"><defs><prop name="header" type="string">Heading.</prop></defs><b>{$header}</b></template>
            <template component="x-list"><defs><slot accepts="x-column" as="columns"></slot></defs><p>{$columns.length}</p></template>
            <template component="x-page"><defs><prop name="rows" type="list(string)">Rows.</prop></defs><main><x-list><x-column $each="label of $rows" $key="$label" from:header="$label"></x-column></x-list></main></template>
            """).Template("x-page");
        Assert.Contains("duplicate key", Assert.Throws<HtmlNextException>(() => template.Render(new { rows = new[] { "A", "A" } })).Detail);
        using var writer = new StringWriter();
        Assert.Contains("duplicate key", Assert.Throws<HtmlNextException>(() => template.Write(writer, new { rows = new[] { "A", "A" } })).Detail);
    }

    [Fact]
    public void PlacingAnEntryUsesTheSameResolvedPropSnapshot()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-column"><defs><prop name="header" type="string" required>Heading.</prop></defs><li>{$header}</li></template>
            <template component="x-list"><defs><slot accepts="x-column" as="columns"></slot><state name="count" type="integer" from="$columns.length"></state></defs><ul data-count="1"><slot></slot></ul></template>
            <template component="x-page"><main><x-list><x-column></x-column></x-list></main></template>
            """).Template("x-page");
        var diagnostics = new List<HtmlNextDiagnostic>();
        var html = template.Render(onDiagnostic: diagnostics.Add);
        Assert.Equal("HNCS003", Assert.Single(diagnostics).Code);
        diagnostics.Clear();
        using var writer = new StringWriter(); template.Write(writer, onDiagnostic: diagnostics.Add);
        Assert.Equal(html, writer.ToString());
        Assert.Equal("HNCS003", Assert.Single(diagnostics).Code);
    }

    [Fact]
    public async Task PlacingRepeatedCallsKeepsEachCollectedInvocationIsolated()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-column"><defs><prop name="header" type="string" required>Heading.</prop></defs><li>{$header}</li></template>
            <template component="x-list"><defs><slot accepts="x-column" as="columns"></slot><state name="count" type="integer" from="$columns.length"></state></defs><ul from:data-count="$count"><slot></slot></ul></template>
            <template component="x-page"><main><x-list><x-column></x-column><x-column></x-column><x-column $each="row of [1,2,3]"></x-column></x-list></main></template>
            """).Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            var diagnostics = new List<HtmlNextDiagnostic>();
            var html = template.Render(onDiagnostic: diagnostics.Add);
            Assert.Equal(5, diagnostics.Count);
            Assert.All(diagnostics, diagnostic => Assert.Equal("HNCS003", diagnostic.Code));
            using var document = new HtmlParser().ParseDocument(html);
            Assert.Equal("5", document.QuerySelector("ul")!.GetAttribute("data-count"));
            Assert.Equal(5, document.QuerySelectorAll("li").Length);
            diagnostics.Clear();
            using var writer = new StringWriter(); template.Write(writer, onDiagnostic: diagnostics.Add);
            Assert.Equal(html, writer.ToString());
            Assert.Equal(5, diagnostics.Count);
        })));
    }

    [Theory]
    [InlineData(false, 0)]
    [InlineData(true, 2)]
    public void PresetsResolveNeededStateAndDeferOtherSeedsUntilPlacement(bool placed, int expectedDiagnostics)
    {
        var source = """
            <template component="x-column"><defs><prop name="header" type="string">Heading.</prop></defs><b>{$header}</b></template>
            <template component="x-preset"><defs><prop name="tone" type="string" default="Preset">Tone.</prop><prop name="bad" type="string" default="bad">Unused seed.</prop><state name="resolved" type="string" from="$tone"></state><state name="unused" type="integer" from="$bad"></state></defs><x-column from:header="$resolved"></x-column></template>
            <template component="x-list"><defs><slot accepts="x-column" as="columns"></slot></defs><ul><li $each="column of $columns">{$column.header}</li>PLACEMENT</ul></template>
            <template component="x-page"><main><x-list><x-preset></x-preset><x-preset tone="Caller"></x-preset></x-list></main></template>
            """.Replace("PLACEMENT", placed ? "<slot></slot>" : "", StringComparison.Ordinal);
        var template = HtmlNextCompiler.CompileResource(source).Template("x-page");
        var diagnostics = new List<HtmlNextDiagnostic>();
        var html = template.Render(onDiagnostic: diagnostics.Add);
        Assert.Equal(expectedDiagnostics, diagnostics.Count);
        Assert.All(diagnostics, diagnostic => Assert.Equal("HNCS004", diagnostic.Code));
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal(new[] { "Preset", "Caller" }, document.QuerySelectorAll("li").Select(element => element.TextContent));
        Assert.Equal(placed ? new[] { "Preset", "Caller" } : [], document.QuerySelectorAll("b").Select(element => element.TextContent));
        diagnostics.Clear();
        using var writer = new StringWriter(); template.Write(writer, onDiagnostic: diagnostics.Add);
        Assert.Equal(html, writer.ToString());
        Assert.Equal(expectedDiagnostics, diagnostics.Count);
    }

    [Theory]
    [InlineData("<prop name='entry' type='object({ header: string })'>Foreign entry.</prop>", "$entry", "cell")]
    [InlineData("<computed name='copy' from='{ header: $columns[0].header }'></computed>", "$copy", "cell")]
    [InlineData("", "$columns[0]", "missing")]
    public void RejectsForeignOrCopiedEntriesAndUnknownBorrowedSlots(string declarations, string entry, string slot)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource("<template component='x-column'><defs><prop name='header' type='string'>Heading.</prop><slot name='cell'></slot></defs><b></b></template><template component='x-list'><defs><slot accepts='x-column' as='columns'></slot>" + declarations + "</defs><ul><slot of=\"" + entry + "\" name='" + slot + "'></slot></ul></template>"));
    }

    [Fact]
    public void CollectionObservesCancellationBetweenAcceptedChildren()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-column"><defs><prop name="header" type="string" required>Heading.</prop></defs><b></b></template>
            <template component="x-list"><defs><slot accepts="x-column" as="columns"></slot></defs><ul></ul></template>
            <template component="x-page"><main><x-list><x-column></x-column><x-column></x-column></x-list></main></template>
            """).Template("x-page");
        using var rendered = new CancellationTokenSource();
        Assert.Throws<OperationCanceledException>(() => template.Render(cancellationToken: rendered.Token, onDiagnostic: _ => rendered.Cancel()));
        using var streamed = new CancellationTokenSource();
        using var writer = new StringWriter();
        Assert.Throws<OperationCanceledException>(() => template.Write(writer, cancellationToken: streamed.Token, onDiagnostic: _ => streamed.Cancel()));
        Assert.NotEmpty(template.Render());
    }

    private sealed class CountingRow(double value, string label)
    {
        public int Reads;
        public double n { get { Reads++; return value; } }
        public string name { get { Reads++; return label; } }
    }

    private static void RemoveMarks(INode node)
    {
        foreach (var child in node.ChildNodes.ToArray())
            if (child is IComment comment && (comment.Data.StartsWith("?start slot=", StringComparison.Ordinal) || comment.Data.StartsWith("?marker slot=", StringComparison.Ordinal) || comment.Data == "?end?")) node.RemoveChild(child);
            else RemoveMarks(child);
    }
}
