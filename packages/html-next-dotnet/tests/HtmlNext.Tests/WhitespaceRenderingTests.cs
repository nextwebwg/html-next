using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using HtmlNext;
using Xunit;

namespace HtmlNext.Tests;

public sealed class WhitespaceRenderingTests
{
    [Fact]
    public void DropsTableStructuralWhitespaceThroughTransparentTemplates()
    {
        var source = """
            <template component="x-table"><table>
              <tbody>
                <template $each="row of [1, 2]">
                  <tr>
                    <td> Cell {$row} </td>
                  </tr>
                </template>
              </tbody>
            </table></template>
            """;
        var root = new HtmlParser().ParseDocument(HtmlNextCompiler.Compile(source).Render()).QuerySelector("table")!;
        foreach (var element in root.QuerySelectorAll("tbody, tr").Prepend(root))
            Assert.DoesNotContain(element.ChildNodes, node => node is IText);
        Assert.Equal(new[] { " Cell 1 ", " Cell 2 " }, root.QuerySelectorAll("td").Select(cell => cell.TextContent));
    }

    [Fact]
    public void DropsSvgContainerWhitespaceWhileKeepingTextContent()
    {
        var source = """
            <template component="x-svg"><svg>
              <g>
                <path d="M0 0"></path>
              </g>
              <text> label </text>
            </svg></template>
            """;
        var root = new HtmlParser().ParseDocument(HtmlNextCompiler.Compile(source).Render()).QuerySelector("svg")!;
        Assert.DoesNotContain(root.ChildNodes, node => node is IText);
        Assert.DoesNotContain(root.QuerySelector("g")!.ChildNodes, node => node is IText);
        Assert.Equal(" label ", root.QuerySelector("text")!.TextContent);
    }
}
