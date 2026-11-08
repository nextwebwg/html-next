using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using AngleSharp.Html.Parser.Tokens;

namespace HtmlNext;

public static partial class HtmlNextCompiler
{
    private static INodeList ParseSourceFragment(string source, IDocument document, string sourceName)
    {
        HashSet<int>? selects = null;
        char[]? masked = null;
        if (source.Contains("<select", StringComparison.OrdinalIgnoreCase) || source.Contains("</select", StringComparison.OrdinalIgnoreCase))
        {
            // AngleSharp still drops direct select children such as slot. Use its tokenizer to
            // mask only real select tags, retaining offsets and leaving strings and comments intact.
            var scan = new HtmlParser(new HtmlParserOptions
            {
                OnToken = (token, _) =>
                {
                    if (token is not HtmlTagToken { Name: "select" }) return;
                    (selects ??= []).Add(token.Position.Position);
                    var name = token.Position.Position + (token.Type == HtmlTokenType.EndTag ? 1 : 0);
                    (masked ??= source.ToCharArray())[name + 1] = '-';
                }
            });
            scan.ParseFragment(source, document.Body!);
        }
        var replacements = new List<IElement>();
        var parser = new HtmlParser(new HtmlParserOptions
        {
            OnCreated = (element, position) =>
            {
                if (element.LocalName == "s-lect" && selects?.Contains(position.Position) == true) replacements.Add(element);
            }
        });
        parser.Error += (_, error) =>
        {
            if (error is AngleSharp.Html.Dom.Events.HtmlErrorEvent detail)
                throw ValueType.Error(sourceName, $"HTML parsing failed at {detail.Position}: {detail.Message}");
        };
        var nodes = parser.ParseFragment(masked is null ? source : new string(masked), document.Body!);
        foreach (var placeholder in replacements)
        {
            var select = placeholder.Owner!.CreateElement(placeholder.NamespaceUri, "select");
            foreach (var attribute in placeholder.Attributes.ToArray())
            {
                placeholder.Attributes.RemoveNamedItem(attribute.Name);
                select.Attributes.SetNamedItem(attribute);
            }
            while (placeholder.FirstChild is { } child) select.AppendChild(child);
            placeholder.Parent!.ReplaceChild(select, placeholder);
        }
        return nodes;
    }
}
