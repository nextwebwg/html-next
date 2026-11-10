using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class SelectRenderingTests
{
    [Fact]
    public void RendersNativeSelectAttributesAndOptions()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-select"><defs><prop name="disabled" type="boolean" default="false">Disabled.</prop></defs><select from:disabled="$disabled"><option value="a">A</option><option value="b" selected>B</option></select></template>
            """);
        Assert.Equal("<select><option value=\"a\">A</option><option value=\"b\" selected=\"\">B</option></select>", template.Render());
        Assert.Equal("<select disabled=\"\"><option value=\"a\">A</option><option value=\"b\" selected=\"\">B</option></select>", template.Render(new { disabled = true }));
    }

    [Fact]
    public void PreservesSelectSlotFallbackAndProjectedOptions()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-select"><select><slot><option value="fallback">Fallback</option></slot></select></template>
            <template component="x-page"><main><x-select><optgroup label="Group"><option value="a">A</option></optgroup></x-select></main></template>
            """);
        Assert.Equal("<select><?start slot=\"\" fallback=\"\"?><option value=\"fallback\">Fallback</option><?end?></select>", graph.Template("x-select").Render());
        Assert.Equal("<main><select><?start slot=\"\"?><optgroup label=\"Group\"><option value=\"a\">A</option></optgroup><?end?></select></main>", graph.Template("x-page").Render());
    }

    [Fact]
    public void PreservesStructuralTemplatesAndCustomizableSelectContent()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-select"><select><button><selectedcontent></selectedcontent></button><template $each="item of ['A', 'B']"><option from:value="$item"><span>{$item}</span></option></template></select></template>
            """);
        Assert.Equal("<select><button><selectedcontent></selectedcontent></button><option value=\"A\"><span>A</span></option><option value=\"B\"><span>B</span></option></select>", template.Render());
    }

    [Fact]
    public void PreservesParsedSelectDirectiveAttributes()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="x-select" noforward><select $ref="control" $attributes><option>A</option></select></template>
            <template component="x-page"><main><x-select id="choice" aria-label="Choices"></x-select></main></template>
            """);
        Assert.Equal("<main><select id=\"choice\" aria-label=\"Choices\"><option>A</option></select></main>", graph.Template("x-page").Render());
    }

    [Fact]
    public void PreservesForeignSelectNamespacesAndNamespacedAttributes()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-select"><svg><select xml:lang="en"><text>SVG</text></select><foreignObject><select><slot><option>HTML</option></slot></select></foreignObject></svg></template>
            """);
        Assert.Equal("<svg><select xml:lang=\"en\"><text>SVG</text></select><foreignObject><select><?start slot=\"\" fallback=\"\"?><option>HTML</option><?end?></select></foreignObject></svg>", template.Render());
    }

    [Fact]
    public void LeavesLiteralSelectTextAndAuthoredPlaceholderNamesIntact()
    {
        var graph = HtmlNextCompiler.CompileResource("""
            <template component="s-lect"><strong>Other</strong></template>
            <template component="x-select"><main data-literal="<select>"><textarea><select>Text</select></textarea><!-- <select><slot></slot></select> --><s-lect></s-lect><SeLeCt><slot><option>A</option></slot></SeLeCt></main></template>
            """);
        Assert.Equal("<main data-literal=\"&lt;select&gt;\"><textarea>&lt;select&gt;Text&lt;/select&gt;</textarea><strong>Other</strong><select><?start slot=\"\" fallback=\"\"?><option>A</option><?end?></select></main>", graph.Template("x-select").Render());
    }
}
