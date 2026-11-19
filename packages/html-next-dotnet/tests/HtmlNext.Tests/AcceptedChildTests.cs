using System.Text.Json;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class AcceptedChildTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "accepted-children.json")));
        foreach (var entry in document.RootElement.EnumerateArray())
            yield return [entry.GetProperty("name").GetString()!, entry.GetProperty("source").GetString()!, entry.GetProperty("expected").GetString()!, entry.GetProperty("diagnostics").GetInt32()];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task FiltersAssignedContentWithoutCreatingAChildList(string name, string source, string expected, int warningCount)
    {
        var template = HtmlNextCompiler.CompileResource(source, name + ".html").Template("x-page");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            var warnings = new List<HtmlNextDiagnostic>();
            var html = template.Render(onDiagnostic: warnings.Add);
            Assert.Equal(warningCount, warnings.Count);
            Assert.All(warnings, warning => Assert.Contains("left out", warning.Message));
            using var document = new HtmlParser().ParseDocument(html);
            var root = document.Body!.FirstElementChild!;
            Assert.Empty(root.QuerySelectorAll("template[carrier]"));
            RemoveMarks(root);
            Assert.Equal(expected, root.OuterHtml);
            warnings.Clear();
            using var writer = new StringWriter();
            template.Write(writer, onDiagnostic: warnings.Add);
            Assert.Equal(html, writer.ToString());
            Assert.Equal(warningCount, warnings.Count);
        })));
    }

    private static void RemoveMarks(INode node)
    {
        foreach (var child in node.ChildNodes.ToArray())
            if (child is IComment comment && (comment.Data.StartsWith("?start slot=", StringComparison.Ordinal) || comment.Data.StartsWith("?marker slot=", StringComparison.Ordinal) || comment.Data == "?end?")) node.RemoveChild(child);
            else RemoveMarks(child);
    }

    [Theory]
    [InlineData("<slot accepts=\"\"></slot>")]
    [InlineData("<slot accepts=\"div\"></slot>")]
    [InlineData("<slot accepts=\"x-column\u00a0x-other\"></slot>")]
    [InlineData("<slot accepts=\"x-column\"><prop name=\"row\" type=\"string\">Row.</prop></slot>")]
    public void RejectsInvalidAcceptsDeclarations(string declaration)
    {
        Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource($"<template component=\"x-list\"><defs>{declaration}</defs><section><slot></slot></section></template>"));
    }

    [Fact]
    public void KeepsUnplacedAcceptedChildrenDeferredWithoutAnAsList()
    {
        var template = HtmlNextCompiler.CompileResource("""
            <template component="x-column"><defs><prop name="label" type="string" required>Label.</prop></defs><b>{$label}</b></template>
            <template component="x-list"><defs><slot accepts="x-column"></slot></defs><section></section></template>
            <template component="x-page"><main><x-list><x-column></x-column></x-list></main></template>
            """).Template("x-page");
        var warnings = new List<HtmlNextDiagnostic>();
        const string expected = "<main><section><template carrier=\"x-list\"><x-column></x-column></template></section></main>";
        Assert.Equal(expected, template.Render(onDiagnostic: warnings.Add));
        using var writer = new StringWriter();
        template.Write(writer, onDiagnostic: warnings.Add);
        Assert.Equal(expected, writer.ToString());
        Assert.Empty(warnings);
    }
}
