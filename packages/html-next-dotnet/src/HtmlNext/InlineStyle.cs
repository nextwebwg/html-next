using AngleSharp;
using AngleSharp.Text;
using AngleSharp.Css;
using AngleSharp.Css.Dom;
using AngleSharp.Css.Parser;
using System.Text.RegularExpressions;

namespace HtmlNext;

// AngleSharp's CSSOM owns property grammar and shorthand values. The adapter supplies custom-value
// token boundaries and ordered serialization that the managed CSSOM does not expose directly.
internal sealed class InlineStyle
{
    private ICssStyleDeclaration style;
    private static readonly DefaultDeclarationFactory Factory = new();
    private readonly List<string> order = [];
    internal static string? Write(string? literal, string name, string value)
    {
        if (!Admissible(value)) return literal;
        var candidate = new CssParser().ParseDeclaration("")!;
        if (value.Length > 0)
        {
            if (name.StartsWith("--", StringComparison.Ordinal)) candidate.SetProperty(name, value);
            else candidate = new CssParser().ParseDeclaration(name + ": " + value)!;
            if (candidate.Length == 0) return literal;
        }
        var style = new InlineStyle(literal ?? "");
        if (value.Length == 0 && !style.Names(name).Any(style.order.Contains)) return literal;
        style.Set(name, value);
        return style.Text;
    }
    private static readonly (string Name, string Initial)[] BorderResets =
        [("border-image-source", "none"), ("border-image-slice", "100%"), ("border-image-width", "1"), ("border-image-outset", "0"), ("border-image-repeat", "stretch")];

    private InlineStyle(string literal)
    {
        var parser = new CssParser();
        var initial = new List<(string Name, bool Important)>();
        var ordinary = new List<string>();
        var custom = new List<(string Name, string Value, bool Important)>();
        foreach (var part in Parts(literal, ';'))
        {
            var fields = Parts(part, ':').ToArray();
            if (fields.Length < 2) continue;
            var colon = fields[0].Length;
            var writtenName = Regex.Replace(part[..colon], @"/\*.*?\*/", " ", RegexOptions.Singleline).Trim();
            var name = writtenName.StartsWith("--", StringComparison.Ordinal)
                ? parser.ParseDeclaration(writtenName + ": 0")?.FirstOrDefault()?.Name
                : IdentParser.ParseIdent(new StringSource(writtenName));
            if (name is null) continue;
            var text = part[(colon + 1)..].Trim();
            if (!name.StartsWith("--", StringComparison.Ordinal))
            {
                var declaration = parser.ParseDeclaration(part)!;
                foreach (var property in declaration) initial.Add((property.Name, property.IsImportant));
                ordinary.Add(part);
                if (name.Equals("border", StringComparison.OrdinalIgnoreCase) && declaration.Length > 0
                    && !declaration.Any(property => property.Value.Length == 0))
                {
                    var value = declaration.GetPropertyValue("border");
                    var wide = value is "inherit" or "initial" or "unset" or "revert" or "revert-layer";
                    var important = declaration.GetPropertyPriority("border") == "important";
                    foreach (var reset in BorderResets)
                    {
                        ordinary.Add(reset.Name + ": " + (wide ? value : reset.Initial) + (important ? " !important" : ""));
                        initial.Add((reset.Name, important));
                    }
                }
                continue;
            }
            var priority = false;
            var bangs = Parts(text, '!').ToArray();
            if (bangs.Length > 1)
            {
                var tail = text[(bangs[0].Length + 1)..];
                tail = Regex.Replace(tail, @"/\*.*?\*/", " ", RegexOptions.Singleline);
                if (!Regex.IsMatch(tail, @"^[\t\n\f\r ]*important[\t\n\f\r ]*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) continue;
                text = bangs[0].TrimEnd(); priority = true;
            }
            if (!Admissible(text)) continue;
            initial.Add((name, priority)); custom.Add((name, text, priority));
        }
        // Parse ordinary declarations together so AngleSharp retains pending shorthand values.
        style = parser.ParseDeclaration(string.Join(';', ordinary))!;
        foreach (var entry in custom)
        {
            if (style.GetPropertyPriority(entry.Name) == "important" && !entry.Important) continue;
            style.SetProperty(entry.Name, entry.Value.Length == 0 ? " " : entry.Value, entry.Important ? "important" : null);
        }
        foreach (var item in initial.Where(item => !item.Important).Concat(initial.Where(item => item.Important)))
            foreach (var name in Names(item.Name)) { order.Remove(name); order.Add(name); }
    }
    private IEnumerable<string> Names(string name)
    {
        var longhands = Factory.Create(name)?.Longhands;
        if (longhands is null || longhands.Length == 0) yield return name;
        else foreach (var longhand in longhands) foreach (var item in Names(longhand)) yield return item;
    }
    private string Text
    {
        get
        {
            var collector = new DeclarationCollector();
            style.ToCss(TextWriter.Null, collector);
            var values = collector.Values.SelectMany(value =>
            {
                var names = Names(value.Name).ToArray();
                if (names.Length == 1 && names[0] == value.Name) return new[] { value };
                var expanded = names.Select(name =>
                {
                    var property = style.GetProperty(name);
                    return (Name: name, Value: property?.Value ?? "", Important: property?.IsImportant ?? false);
                }).ToArray();
                return expanded.Any(item => item.Value.Length == 0) ? [value] : expanded;
            }).OrderBy(value => value.Name.StartsWith("--", StringComparison.Ordinal) && Parts(value.Value + ";boundary", ';').Count() == 1)
                .ThenBy(value => order.IndexOf(value.Name)).ToArray();
            return string.Join("; ", values.Select(value => value.Name + ": " + value.Value + (value.Important ? " !important" : "")));
        }
    }
    private void Set(string name, string value)
    {
        if (value.Length == 0) { style.RemoveProperty(name); foreach (var item in Names(name)) order.Remove(item); return; }
        if (name.StartsWith("--", StringComparison.Ordinal)) style.SetProperty(name, value, "important");
        else
        {
            var replacement = new InlineStyle(Text + "; " + name + ": " + value + " !important");
            style = replacement.style; order.Clear(); order.AddRange(replacement.order);
        }
        if (style.GetProperty(name) is { } own) own.IsImportant = false;
        foreach (var item in Names(name)) if (style.GetProperty(item) is { } property) property.IsImportant = false;
        if (name == "border") foreach (var reset in BorderResets) if (style.GetProperty(reset.Name) is { } property) property.IsImportant = false;
        foreach (var item in Names(name)) if (!order.Contains(item)) order.Add(item);
    }
    private static bool Admissible(string text)
    {
        var stack = new Stack<char>();
        var quote = '\0';
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quote == '\0' && (char.IsAsciiLetter(c) || c is '_' or '-' or '\\' || c >= 128)
                && (i == 0 || !(char.IsAsciiLetterOrDigit(text[i - 1]) || text[i - 1] is '_' or '-' or '\\' || text[i - 1] >= 128)))
            {
                var identifier = new StringSource(text[i..]);
                var name = IdentParser.ParseIdent(identifier);
                if (name is not null && name.Equals("url", StringComparison.OrdinalIgnoreCase)
                    && i + identifier.Index < text.Length && text[i + identifier.Index] == '(')
                {
                    var uri = new StringSource("url" + text[(i + identifier.Index)..]);
                    if (CssUriParser.ParseUri(uri) is null) return false;
                    i += Math.Min(text.Length - i, identifier.Index + uri.Index - 3) - 1;
                    continue;
                }
                if (identifier.Index > 0) { i += identifier.Index - 1; continue; }
            }
            if (c == '\\') { i++; continue; }
            if (quote != '\0') { if (c == quote) quote = '\0'; else if (c is '\n' or '\r' or '\f') return false; continue; }
            if (c is '\'' or '"') { quote = c; continue; }
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '*') { var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal); if (end < 0) break; i = end + 1; continue; }
            if (c is '(' or '[' or '{') stack.Push(c);
            else if (c is ')' or ']' or '}')
            {
                if (!stack.TryPop(out var open) || (open, c) is not (('(', ')') or ('[', ']') or ('{', '}'))) return false;
            }
            else if (stack.Count == 0 && c is ';' or '!') return false;
        }
        return true;
    }
    private static IEnumerable<string> Parts(string text, char separator)
    {
        var stack = new Stack<char>();
        var quote = '\0';
        var start = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\\') { i++; continue; }
            if (quote != '\0') { if (c == quote) quote = '\0'; continue; }
            if (c is '\'' or '"') { quote = c; continue; }
            if (c == '/' && i + 1 < text.Length && text[i + 1] == '*') { var end = text.IndexOf("*/", i + 2, StringComparison.Ordinal); if (end < 0) break; i = end + 1; continue; }
            if (c is '(' or '[' or '{') stack.Push(c);
            else if (c is ')' or ']' or '}' && stack.Count > 0) stack.Pop();
            else if (c == separator && stack.Count == 0) { yield return text[start..i]; start = i + 1; }
        }
        yield return text[start..];
    }
}

internal sealed class DeclarationCollector : IStyleFormatter
{
    internal readonly List<(string Name, string Value, bool Important)> Values = [];
    public string Declaration(string name, string value, bool important)
    {
        Values.Add((name, value, important));
        return "";
    }
    public string BlockDeclarations(IEnumerable<IStyleFormattable> declarations)
    {
        foreach (var declaration in declarations) declaration.ToCss(TextWriter.Null, this);
        return "";
    }
    public string Sheet(IEnumerable<IStyleFormattable> rules) => throw new NotSupportedException();
    public string Rule(string name, string value) => throw new NotSupportedException();
    public string Rule(string name, string prelude, string body) => throw new NotSupportedException();
    public string BlockRules(IEnumerable<IStyleFormattable> rules) => throw new NotSupportedException();
    public string Comment(string value) => "";
}
