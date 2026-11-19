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

    [Theory]
    [InlineData(0, "0", "One")]
    [InlineData(1, "1", "Two")]
    [InlineData(99, "", "Empty")]
    public void IdentifiesBorrowedSlotRangesByTheirEntryPosition(int index, string marker, string text)
    {
        var source = """
            <template component="x-column"><defs><slot name="cell"></slot><slot name="missing"></slot></defs><aside></aside></template>
            <template component="x-list"><defs><prop name="index" type="integer">Index.</prop><slot accepts="x-column" as="columns"></slot></defs>
            <section><slot of="$columns[$index]" name="cell">Empty</slot><slot of="$columns[0]" name="missing"></slot><slot></slot></section></template>
            <template component="x-page"><defs><prop name="index" type="integer">Index.</prop></defs><main><x-list from:index="$index">
            <x-column><b slot="cell">One</b></x-column><x-column><b slot="cell">Two</b></x-column></x-list></main></template>
            """;
        var template = HtmlNextCompiler.CompileResource(source).Template("x-page");
        var html = template.Render(new { index });
        using var writer = new StringWriter();
        template.Write(writer, new { index });
        Assert.Equal(html, writer.ToString());
        Assert.Contains($"<?start slot=\"cell\" of=\"{marker}\"" + (marker.Length == 0 ? " fallback=\"\"" : "") + "?>", html);
        Assert.Contains("<?start slot=\"missing\" of=\"0\" fallback=\"\"?><?end?>", html);
        using var document = new HtmlParser().ParseDocument(html);
        Assert.StartsWith(text, document.QuerySelector("section")!.TextContent);
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
    public async Task SelectedEntryDefaultsUseTheChildSelectorInDirectAndAliasedReads()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-field"><defs>
            <type name="shape" from="mode"><option value="a" type="object({ left: string, right: number })"></option><option value="b" type="object({ left: number, right: number })"></option></type>
            <prop name="value" type="shape" default="{left:'bad',right:3}">Value.</prop>
            <prop name="mode" type="keyword" values="a, b" default="a">Mode.</prop>
            </defs><span>{$value.left}:{$value.right}</span></template>
            <template component="x-list"><defs>
            <prop name="mode" type="keyword" values="a, b" default="a">Outer mode.</prop>
            <slot accepts="x-field" as="fields"></slot>
            <computed name="chosen" from="$fields[0]"></computed>
            </defs><article><slot></slot><output>{$fields[0].value.left}:{$fields[0].value.right}</output><b>{$chosen.value.left}:{$chosen.value.right}</b><i $with="$fields[0] as field">{$field.value.left}:{$field.value.right}</i></article></template>
            <template component="x-page"><defs><prop name="mode" type="keyword" values="a, b" default="a">Child mode.</prop></defs><main><x-list><x-field from:mode="$mode"></x-field></x-list></main></template>
            """).Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 16).Select(index => Task.Run(() =>
        {
            var mode = index % 2 == 0 ? "a" : "b";
            var left = index % 2 == 0 ? "bad" : "";
            var html = template.Render(new { mode });
            using var writer = new StringWriter(); template.Write(writer, new { mode });
            Assert.Equal(html, writer.ToString());
            using var document = new HtmlParser().ParseDocument(html);
            Assert.Equal(new[] { left + ":3", left + ":3", left + ":3", left + ":3" },
                document.QuerySelectorAll("span, output, b, i").Select(element => element.TextContent));
        })));
    }

    [Fact]
    public async Task MixedEntryTypesKeepIndependentSelectedFieldsAcrossRequests()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-field"><defs>
            <type name="value-type" from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type>
            <type name="tail-type" from="tailMode"><option value="number" type="number"></option><option value="text" type="string"></option></type>
            <prop name="value" type="value-type" default="3">Value.</prop><prop name="tail" type="tail-type" default="7">Tail.</prop>
            <prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop><prop name="tailMode" type="keyword" values="number, text" default="number">Tail mode.</prop>
            </defs><span>{$value}:{$tail}</span></template>
            <template component="x-other"><defs><prop name="value" type="string" default="Other">Other.</prop></defs><em>{$value}</em></template>
            <template component="x-list"><defs><slot accepts="x-field x-other" as="fields"></slot></defs><article><slot></slot><output>{$fields[0].value}:{$fields[0].tail}</output><i>{$fields[1].value}:{$fields[1].tail}</i></article></template>
            <template component="x-page"><defs><prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop><prop name="tailMode" type="keyword" values="number, text" default="number">Tail mode.</prop></defs><main><x-list><x-field from:mode="$mode" from:tail-mode="$tailMode"></x-field><x-other></x-other></x-list></main></template>
            """).Template("x-page");
        (string Mode, string Tail, string Expected)[] cases = [("number", "number", "3:7"), ("text", "number", ":7"), ("number", "text", "3:"), ("text", "text", ":")];
        await Task.WhenAll(Enumerable.Range(0, 32).Select(index => Task.Run(() =>
        {
            var item = cases[index % cases.Length];
            var html = template.Render(new { mode = item.Mode, tailMode = item.Tail });
            using var writer = new StringWriter(); template.Write(writer, new { mode = item.Mode, tailMode = item.Tail });
            Assert.Equal(html, writer.ToString());
            using var document = new HtmlParser().ParseDocument(html);
            Assert.Equal(item.Expected, document.QuerySelector("span")!.TextContent);
            Assert.Equal(item.Expected, document.QuerySelector("output")!.TextContent);
            Assert.Equal("Other:", document.QuerySelector("i")!.TextContent);
        })));
    }

    [Fact]
    public void SeedingUntypedStateCopiesSelectedEntryDataWithoutKeepingItsTypeScope()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-field"><defs>
            <type name="value-type" from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type>
            <prop name="value" type="value-type" default="3">Value.</prop><prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop>
            </defs><span>{$value}</span></template>
            <template component="x-list"><defs><slot accepts="x-field" as="fields"></slot><state name="copy" from="$fields[0]"></state></defs><article><output>{$copy = $fields[0]}:{$copy.value}</output></article></template>
            <template component="x-page"><main><x-list><x-field mode="text"></x-field></x-list></main></template>
            """).Template("x-page");
        var html = template.Render();
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(html, writer.ToString());
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal("false:3", document.QuerySelector("output")!.TextContent);
    }

    [Fact]
    public void SelectedEntriesKeepBorrowedSlotsInTheOriginalCallerScope()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-field"><defs>
            <type name="value-type" from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type>
            <prop name="value" type="value-type" default="3">Value.</prop><prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop>
            <slot name="cell"><prop name="text" type="string">Text.</prop></slot>
            </defs><span><slot name="cell"></slot></span></template>
            <template component="x-list"><defs><slot accepts="x-field" as="fields"></slot></defs><article><slot of="$fields[0]" name="cell" text="row"></slot><output>{$fields[0].value}</output></article></template>
            <template component="x-page"><defs><prop name="label" type="string" default="Parent">Label.</prop></defs><main><x-list><x-field mode="text"><template slot="cell">{$label}:{$text}</template></x-field></x-list></main></template>
            """).Template("x-page");
        var html = template.Render();
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(html, writer.ToString());
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal("Parent:row", document.QuerySelector("article")!.TextContent);
        Assert.Equal("", document.QuerySelector("output")!.TextContent);
    }

    [Fact]
    public void EntryObjectSizeIncludesOnlyPropsAndCopiesExcludePrivateStateSlots()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-field"><defs><state name="label" type="string" value="private"></state></defs><span>{$label}</span></template>
            <template component="x-list"><defs><slot accepts="x-field" as="fields"></slot><state name="copy" from="$fields[0]"></state></defs><article><output>{$fields[0] ? 'wrong' : 'empty'}:{$copy ? 'wrong' : 'empty'}:{$copy = $fields[0]}</output></article></template>
            <template component="x-page"><main><x-list><x-field></x-field></x-list></main></template>
            """).Template("x-page");
        var html = template.Render();
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(html, writer.ToString());
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal("empty:empty:false", document.QuerySelector("output")!.TextContent);
    }

    [Fact]
    public void AStateCopyKeepsNestedEntryDataUnderAnUnknownField()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-field"><defs><prop name="payload" type="object({ value: length })" required>Payload.</prop></defs><span>{$payload.value}</span></template>
            <template component="x-list"><defs><slot accepts="x-field" as="fields"></slot><state name="copy" type="object({ payload: unknown })" from="$fields[0]"></state></defs><article><output>{$copy.payload.value}:{$copy.payload.value + 1px}</output></article></template>
            <template component="x-page"><main><x-list><x-field payload="{value:'10px'}"></x-field></x-list></main></template>
            """).Template("x-page");
        var html = template.Render();
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(html, writer.ToString());
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal("10px:", document.QuerySelector("output")!.TextContent);
    }

    [Fact]
    public void AnUnknownScopedPropDoesNotInheritTheEntrysSelectedTypeChecks()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-field"><defs><type name="value-type" from="mode"><option value="number" type="number"></option><option value="text" type="string"></option></type><prop name="value" type="value-type" default="3">Value.</prop><prop name="mode" type="keyword" values="number, text" default="number">Mode.</prop></defs><span>{$value}</span></template>
            <template component="x-list"><defs><slot accepts="x-field" as="fields"></slot><slot name="row"><prop name="entry" type="unknown">Entry.</prop></slot></defs><article><slot name="row" from:entry="$fields[0]"></slot></article></template>
            <template component="x-page"><main><x-list><x-field mode="text"></x-field><template slot="row">{$entry.value}</template></x-list></main></template>
            """).Template("x-page");
        var html = template.Render();
        using var writer = new StringWriter(); template.Write(writer);
        Assert.Equal(html, writer.ToString());
        using var document = new HtmlParser().ParseDocument(html);
        Assert.Equal("3", document.QuerySelector("article")!.TextContent);
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
