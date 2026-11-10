using HtmlNext;
using System.Text.Json;
using System.Globalization;
using Xunit;

namespace HtmlNext.Tests;

public sealed class FormattingTests
{
    private static CompiledTemplate Text(string expression, string declarations = "") => HtmlNextCompiler.Compile(
        "<template component=\"x-format\"><defs>" + declarations + "</defs><output>{" + expression + "}</output></template>", "formatting.html");

    public static IEnumerable<object[]> NumberCases()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures/number-formatting.json")));
        foreach (var item in document.RootElement.EnumerateArray()) yield return [item.GetProperty("name").GetString()!, item.Clone()];
    }

    [Theory]
    [MemberData(nameof(NumberCases))]
    public void MatchesNativeNumberConstructorSemantics(string name, JsonElement fixture)
    {
        var operation = fixture.GetProperty("operation").GetString()!;
        var value = fixture.GetProperty("value");
        var expression = operation + "(" + (value.ValueKind == JsonValueKind.String ? value.GetString() : value.GetRawText());
        if (operation == "formatRange") expression += ", " + fixture.GetProperty("end").GetRawText();
        expression += ", " + fixture.GetProperty("options").GetRawText() + ", " + JsonSerializer.Serialize(fixture.GetProperty("locale").GetString()) + ")";
        var expected = fixture.GetProperty("expected");
        if (operation == "formatParts")
        {
            var source = "<template component=\"x-parts\"><output><span $each=\"part of " + expression.Replace("\"", "&quot;") + "\">{$part.type}:{$part.value}</span></output></template>";
            var template = HtmlNextCompiler.Compile(source, name);
            var parts = expected.EnumerateArray().Select(part => "<span>" + part.GetProperty("type").GetString() + ":" + part.GetProperty("value").GetString() + "</span>");
            Assert.Equal("<output>" + string.Concat(parts) + "</output>", template.Render());
        }
        else
        {
            var template = Text(expression);
            var output = "<output>" + (expected.ValueKind == JsonValueKind.Null ? "" : expected.GetString()) + "</output>";
            Assert.Equal(output, template.Render());
            using var writer = new StringWriter(); template.Write(writer);
            Assert.Equal(output, writer.ToString());
        }
    }

    [Theory]
    [InlineData("format(1234.5, {}, 'en-US')", "1,234.5")]
    [InlineData("format(1234.5, 'number', {}, 'de-DE')", "1.234,5")]
    [InlineData("format(1234.5, 'currency', { currency: 'USD' }, 'en-US')", "$1,234.50")]
    [InlineData("format(-1234.5, 'currency', { currency: 'USD', currencySign: 'accounting' }, 'en-US')", "($1,234.50)")]
    [InlineData("format(0.15, 'percent', {}, 'en-US')", "15%")]
    [InlineData("format(15%, {}, 'en-US')", "15%")]
    [InlineData("format(15%, 'number', {}, 'en-US')", "0.15")]
    [InlineData("format(2.5, 'unit', { unit: 'mile-per-hour', unitDisplay: 'long' }, 'en-US')", "2.5 miles per hour")]
    [InlineData("format(1.005, { maximumFractionDigits: 2 }, 'en-US')", "1.01")]
    [InlineData("format(1.25, { maximumFractionDigits: 1, roundingMode: 'halfEven' }, 'en-US')", "1.2")]
    [InlineData("format(12345, { useGrouping: false, minimumFractionDigits: 2 }, 'en-US')", "12345.00")]
    [InlineData("format(12, { signDisplay: 'always', minimumIntegerDigits: 3 }, 'en-US')", "+012")]
    [InlineData("format(1234567, { notation: 'scientific' }, 'en-US')", "1.235E6")]
    [InlineData("format(12345, { notation: 'engineering' }, 'en-US')", "12.345E3")]
    [InlineData("format(1234567, { notation: 'compact', maximumFractionDigits: 1 }, 'en-US')", "1.2M")]
    [InlineData("formatRange(1, 3, 'currency', { currency: 'USD' }, 'en-US')", "$1.00 \u2013 $3.00")]
    [InlineData("formatRange(1, 1, {}, 'en-US')", "~1")]
    public void FormatsNativeNumbersWithExplicitLocale(string expression, string expected)
    {
        var template = Text(expression);
        Assert.Equal("<output>" + expected + "</output>", template.Render());
        using var writer = new StringWriter();
        template.Write(writer);
        Assert.Equal(template.Render(), writer.ToString());
    }

    [Theory]
    [InlineData("format(null)")]
    [InlineData("format(1 / 0, {}, 'en-US')")]
    [InlineData("format('12', 'number', {}, 'en-US')")]
    [InlineData("format(1, 'currency', {}, 'en-US')")]
    [InlineData("format(1, 'currency', { currency: 'USD', style: 'percent' }, 'en-US')")]
    [InlineData("format(1, { minimumFractionDigits: 5, maximumFractionDigits: 2 }, 'en-US')")]
    [InlineData("format(1, {}, 'en_US')")]
    [InlineData("formatRange(1, null, {}, 'en-US')")]
    public void DoesNotWriteForAbsentOrInvalidFormattingInputs(string expression)
    {
        Assert.Equal("<output></output>", Text(expression).Render());
    }

    [Fact]
    public void ReturnsStructuredNumberPartsForOrdinaryTemplateComposition()
    {
        var template = HtmlNextCompiler.Compile("""
            <template component="x-parts"><div><span $each="part of formatParts(1234.5, {}, 'en-US')">{$part.type}:{$part.value}</span></div></template>
            """, "parts.html");
        Assert.Equal("<div><span>integer:1</span><span>group:,</span><span>integer:234</span><span>decimal:.</span><span>fraction:5</span></div>", template.Render());
    }

    [Fact]
    public void ReadsCurrentTypedInputsWithoutInferringFromStringContents()
    {
        const string declarations = """<prop name="amount" type="number">Amount.</prop><prop name="locale" type="string">Locale.</prop>""";
        var template = Text("format($amount, {}, $locale)", declarations);
        Assert.Equal("<output>1,234.5</output>", template.Render(new { amount = 1234.5, locale = "en-US" }));
        Assert.Equal("<output>1.234,5</output>", template.Render(new { amount = 1234.5, locale = "de-DE" }));
        Assert.Equal("<output></output>", template.Render(new { amount = 1234.5 }));
        Assert.Equal("<output></output>", Text("format($amount, {}, 'en-US')", """<prop name="amount" type="string">Amount.</prop>""").Render(new { amount = "1234.5" }));
    }
    [Theory]
    [InlineData("format()")]
    [InlineData("formatRange(1)")]
    [InlineData("format(1, {}, 'en-US', 2)")]
    [InlineData("formatParts(1, 'number', [], 'en-US')[0].type")]
    [InlineData("format(1, 'number', null, 'en-US')")]
    [InlineData("format(1, 'unknown', {}, 'en-US')")]
    public void InvalidFormatterCallsProduceAnInvalidValue(string expression)
    {
        Assert.Equal("<output></output>", Text("default(" + expression + ", 'fallback')").Render());
    }

    [Fact]
    public void ReadsTheCurrentRequestCultureForAnOmittedLocale()
    {
        var template = Text("format(1234.5)");
        var previous = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
            Assert.Equal("<output>1,234.5</output>", template.Render());
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("de-DE");
            Assert.Equal("<output>1.234,5</output>", template.Render());
        }
        finally { CultureInfo.CurrentCulture = previous; }
    }

    [Fact]
    public void RequiresEverySelectionToAgreeBeforeInferringAFormatter()
    {
        const string declarations = """
            <prop name="mode" type="keyword" values="plain, other" required>Mode.</prop>
            <type name="amount-type" from="mode"><option value="plain" type="number"></option><option value="other" type="number"></option></type>
            <prop name="amount" type="amount-type">Amount.</prop>
            """;
        var same = Text("format($amount, {}, 'en-US')", declarations);
        Assert.Equal("<output>1,234.5</output>", same.Render(new { mode = "plain", amount = 1234.5 }));
        Assert.Equal("<output>1,234.5</output>", same.Render(new { mode = "other", amount = 1234.5 }));
        var mixed = declarations.Replace("value=\"other\" type=\"number\"", "value=\"other\" type=\"string\"");
        Assert.Equal("<output></output>", Text("format($amount, {}, 'en-US')", mixed).Render(new { mode = "plain", amount = 1234.5 }));
        Assert.Equal("<output>1,234.5</output>", Text("format($amount, 'number', {}, 'en-US')", mixed).Render(new { mode = "plain", amount = 1234.5 }));
    }

}
