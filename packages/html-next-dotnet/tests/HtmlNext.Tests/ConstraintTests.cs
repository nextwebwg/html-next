using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class ConstraintTests
{
    private static CompiledTemplate Compile(string attributes, string type = "number") => HtmlNextCompiler.Compile(
        "<template component=\"x-constraints\"><defs><prop name=\"value\" type=\"" + type + "\" " + attributes + ">Value.</prop></defs><output>{$value}</output></template>", "constraints.html");

    [Fact]
    public void AcceptsWellTypedValuesOutsideChoicesAndReportsValiditySeparately()
    {
        var template = Compile("values=\"1, 2, 3\" default=\"2\"", "integer");
        Assert.Equal("<output>4</output>", template.Render(new { value = 4 }));
        var error = Assert.Single(template.Validate(new { value = 4 }));
        Assert.Equal("typeMismatch", error.Reason);
        Assert.Equal("value", error.Path);
        Assert.Empty(template.Validate(new { value = 2 }));
        Assert.Empty(template.Validate());
        var diagnostics = new List<HtmlNextDiagnostic>();
        Assert.Equal("<output>4</output>", template.Render(new { value = 4 }, onDiagnostic: diagnostics.Add));
        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ValidatesPropsIndependentlyOfRenderingDeclarations(bool nested)
    {
        var source = "<template component=\"x-child\"><defs><prop name=\"value\" type=\"integer\">Value.</prop></defs><output>{$value}</output></template>"
            + "<template component=\"x-card\"><defs><prop name=\"value\" type=\"integer\" required>Value.</prop>"
            + (nested ? "" : "<computed name=\"unused\" from=\"$unused\"></computed>")
            + "</defs><div>" + (nested ? "<x-child from:value=\"$value\"></x-child>" : "{$value}") + "</div></template>";
        var template = HtmlNextCompiler.CompileResource(source).Template("x-card");
        Assert.Empty(template.Validate(new { value = 3 }));
        Assert.Equal("typeMismatch", Assert.Single(template.Validate(new { value = "wrong" })).Reason);
        Assert.Equal("valueMissing", Assert.Single(template.Validate()).Reason);
    }

    [Fact]
    public void ValidatesRangesAndUtf16LengthsWithoutReplacingAcceptedValues()
    {
        var number = Compile("min=\"2\" max=\"4\"");
        Assert.Equal("rangeUnderflow", Assert.Single(number.Validate(new { value = 1 })).Reason);
        Assert.Equal("rangeOverflow", Assert.Single(number.Validate(new { value = 5 })).Reason);
        Assert.Equal("<output>5</output>", number.Render(new { value = 5 }));
        var text = Compile("minlength=\"2\" maxlength=\"3\"", "string");
        Assert.Empty(text.Validate(new { value = "👋" }));
        Assert.Equal("tooShort", Assert.Single(text.Validate(new { value = "A" })).Reason);
        Assert.Equal("tooLong", Assert.Single(text.Validate(new { value = "👋👋" })).Reason);
        Assert.Empty(text.Validate(new { value = "" }));
    }

    [Fact]
    public void DistinguishesRequiredEmptyValuesFromWrongTypesAndPreservesFalseAndZero()
    {
        var text = Compile("required minlength=\"2\"", "string");
        Assert.Equal("valueMissing", Assert.Single(text.Validate()).Reason);
        Assert.Equal("valueMissing", Assert.Single(text.Validate(new { value = "" })).Reason);
        Assert.Equal("typeMismatch", Assert.Single(text.Validate(new { value = 5 })).Reason);
        Assert.Empty(Compile("required", "boolean").Validate(new { value = false }));
        Assert.Empty(Compile("required").Validate(new { value = 0 }));
    }

    [Fact]
    public void CollectsApplicableFailuresFromOneStableInputRead()
    {
        var template = Compile("values=\"1,2\" min=\"0\" max=\"3\"");
        var input = new CountingInput();
        var errors = template.Validate(input);
        Assert.Equal(new[] { "rangeOverflow", "typeMismatch" }, errors.Select(error => error.Reason));
        Assert.Equal(1, input.Reads);
        Assert.All(errors, error => Assert.Equal("constraints.html", error.SourceName));
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => template.Validate(input, cancelled.Token));
        Assert.Equal(1, input.Reads);
    }

    private sealed class CountingInput
    {
        public int Reads;
        public int value { get { Reads++; return 5; } }
    }

    [Theory]
    [InlineData("values=\"a, b\" default=\"c\"", "keyword")]
    [InlineData("values=\"1, oops\"", "number")]
    [InlineData("values=\"\"", "string")]
    [InlineData("values=\"one,,two\"", "string")]
    [InlineData("values=\"1,2\"", "list(number)")]
    [InlineData("min=\"NaN\"", "number")]
    [InlineData("min=\"2\"", "string")]
    [InlineData("minlength=\"-1\"", "string")]
    [InlineData("maxlength=\"2.5\"", "string")]
    [InlineData("maxlength=\"2\" default=\"long\"", "string")]
    [InlineData("required default=\"\"", "string")]
    public void RejectsMalformedConstraintsAndInvalidDefaults(string attributes, string type)
    {
        var error = Assert.Throws<HtmlNextException>(() => Compile(attributes, type));
        Assert.Equal("constraints.html", error.SourceName);
    }
}
