using System.Text.Json;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class SelectedTypeTests
{
    public static IEnumerable<object[]> Cases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures/selected-types.json")));
        foreach (var item in document.RootElement.EnumerateArray()) yield return [item.GetProperty("name").GetString()!, item.Clone()];
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void SelectsTheSameAcceptedValueAsNode(string name, JsonElement fixture)
    {
        var graph = HtmlNextCompiler.CompileResource(fixture.GetProperty("source").GetString()!, name);
        var template = graph.Template(fixture.GetProperty("entry").GetString()!);
        var inputs = fixture.GetProperty("inputs");
        var expected = fixture.GetProperty("expected").GetString();
        Assert.Equal(expected, template.Render(inputs));
        using var writer = new StringWriter(); template.Write(writer, inputs);
        Assert.Equal(expected, writer.ToString());
    }

    [Theory]
    [InlineData("<type name=\"number\" from=\"mode\"></type>", "number", "required", "")]
    [InlineData("<type name=\"shape\" from=\"missing\"></type>", "shape", "required", "")]
    [InlineData("<type name=\"shape\" from=\"mode\"><option value=\"text\" type=\"string\"></option></type>", "shape", "required", "")]
    [InlineData("<type name=\"shape\" from=\"mode\"><option value=\"text\" type=\"string\"></option><option value=\"text\" type=\"number\"></option></type>", "shape", "required", "")]
    [InlineData("<type name=\"shape\" from=\"mode\"><option value=\"text\" type=\"string\"></option><option value=\"number\" type=\"number\"></option></type>", "shape", "", "")]
    [InlineData("<type name=\"shape\" from=\"mode\"><option value=\"text\" type=\"string\"></option><option value=\"number\" type=\"number\"></option></type>", "shape", "required", "default=\"3\"")]
    public void RejectsInvalidSelectionContracts(string declaration, string type, string selector, string fallback)
    {
        var source = $"<template component=\"x-field\"><defs>{declaration}<prop name=\"value\" type=\"{type}\" {fallback}>Value.</prop><prop name=\"mode\" type=\"keyword\" values=\"text, number\" {selector}>Mode.</prop></defs><output>{{$value}}</output></template>";
        Assert.Equal("HNCS001", Assert.Throws<HtmlNextException>(() => HtmlNextCompiler.CompileResource(source)).Code);
    }

    [Fact]
    public void ValidatesUsingTheSelectedTypeAndKeepsRequestsIndependent()
    {
        var fixture = Cases().First()[1] is JsonElement item ? item : throw new InvalidOperationException();
        var template = HtmlNextCompiler.CompileResource(fixture.GetProperty("source").GetString()!).Template("x-field");
        Assert.Empty(template.Validate(new { mode = "number", value = 3 }));
        Assert.Equal("typeMismatch", Assert.Single(template.Validate(new { mode = "number", value = "3" })).Reason);
        Assert.Equal("<output>3:false</output>", template.Render(new { mode = "text", value = "3" }));
        Assert.Equal("<output>3:true</output>", template.Render(new { mode = "number", value = 3 }));
    }
}
