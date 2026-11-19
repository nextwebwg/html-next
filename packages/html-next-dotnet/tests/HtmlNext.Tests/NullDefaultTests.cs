using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class NullDefaultTests
{
    private static CompiledTemplate Template(string props, string body) => HtmlNextCompiler.Compile(
        "<template component=\"x-null-defaults\"><defs>" + props + "</defs>" + body + "</template>", "null-defaults.html");

    [Fact]
    public void NullAndMissingUseDefaultsWhileEmptyFalseAndZeroStayPresent()
    {
        var template = Template("""
            <prop name="text" type="string" default="Fallback">Text.</prop>
            <prop name="count" type="number" default="7">Count.</prop>
            <prop name="enabled" type="boolean" default="true">Enabled.</prop>
            """, "<output>{$text}:{$count}:{$enabled}</output>");
        var absent = "<output>Fallback:7:true</output>";
        Assert.Equal(absent, template.Render());
        Assert.Equal(absent, template.Render(new { text = (object?)null, count = (object?)null, enabled = (object?)null }));
        Assert.Equal("<output>:0:false</output>", template.Render(new { text = "", count = 0, enabled = false }));
        using var writer = new StringWriter(); template.Write(writer, new { count = (object?)null });
        Assert.Equal(absent, writer.ToString());
    }

    [Fact]
    public void RequiredValidityUsesTheEffectiveDefaultForNullInputs()
    {
        var template = Template("""<prop name="value" type="number" default="5" required>Value.</prop>""", "<output>{$value}</output>");
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<output>5</output>", template.Render(new { value = (object?)null }, onDiagnostic: diagnostics.Add));
        Assert.Empty(diagnostics);
        Assert.Empty(template.Validate(new { value = (object?)null }));
        var missing = Template("""<prop name="value" type="number" required>Value.</prop>""", "<output>{$value}</output>");
        Assert.Equal("valueMissing", Assert.Single(missing.Validate(new { value = (object?)null })).Reason);
        Assert.Equal("<output></output>", missing.Render(new { value = (object?)null }));
    }

    [Fact]
    public void NullInputsUseStructuredDefaultsAndEmptyListsStayPresent()
    {
        var template = Template("""<prop name="rows" type="list(object({ label: string }))" default="[{ label: 'Default' }]">Rows.</prop>""",
            "<ul><li $each=\"row of $rows\">{$row.label}</li></ul>");
        Assert.Equal("<ul><li>Default</li></ul>", template.Render(new { rows = (object?)null }));
        Assert.Equal("<ul></ul>", template.Render(new { rows = Array.Empty<object>() }));
        Assert.Empty(template.Validate(new { rows = (object?)null }));
    }
}
