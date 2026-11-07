using AngleSharp.Dom;

namespace HtmlNext;

internal sealed record SelectedTypeOption(ExpressionValue Value, ValueType Type);

internal sealed class SelectedType(string from, bool state, SelectedTypeOption[] options, ValueType? defaultType)
{
    private BoundPath selector = null!;
    public bool FromState { get; } = state;
    public ValueType? DefaultType { get; } = defaultType;
    public int PreparationSlot { get; private set; } = -1;
    public void Link(IReadOnlyDictionary<string, (int Slot, ValueType Type)> bindings, LocalDeclaration? declaration, int preparationSlot)
    {
        var binding = bindings[From];
        selector = new(binding.Slot, [], binding.Type, Declaration: declaration);
        PreparationSlot = preparationSlot;
    }
    public string From { get; } = from;
    public ValueType? Read(object?[] values)
    {
        var value = ExpressionValue.StoredValue(selector.Read(values), selector.Type);
        foreach (var option in options) if (Same(option.Value, value)) return option.Type;
        return null;
    }
    internal static bool Same(ExpressionValue left, ExpressionValue right) => left.IsNumeric && right.IsNumeric ? left.Number == right.Number
        : left.IsText && right.IsText ? string.Equals((string?)left.Data, (string?)right.Data, StringComparison.Ordinal)
        : left.Type.Kind == "boolean" && right.Type.Kind == "boolean" && left.Number == right.Number
            || left.IsDimension && right.IsDimension && left.ScalarText() == right.ScalarText();
}

internal static class SelectedTypes
{
    private static readonly HashSet<string> BuiltIns = new("string keyword boolean number integer url email date month week time datetime-local datetime color color-hex length percentage duration null absent trusted-html trusted-script function unknown event list record object".Split(' '), StringComparer.Ordinal);

    public static Dictionary<string, IElement> Named(IElement group, string source)
    {
        var named = new Dictionary<string, IElement>(StringComparer.Ordinal);
        foreach (var element in group.Children.Where(child => child.LocalName == "type"))
        {
            var name = element.GetAttribute("name") ?? "";
            if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z][a-z0-9-]*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant)
                || BuiltIns.Contains(name) || !named.TryAdd(name, element))
                throw ValueType.Error(source, "Named types require distinct lowercase names that do not shadow built-in types.");
        }
        return named;
    }

    public static SelectedType? Read(IElement prop, string source)
    {
        var group = prop.ParentElement!;
        var named = Named(group, source);
        var inline = prop.Children.Where(child => child.LocalName == "type").ToArray();
        if (inline.Length > 1 || inline.Length == 1 && (prop.HasAttribute("type") || inline[0].HasAttribute("name")))
            throw ValueType.Error(source, "A prop declares one type, inline without a name or by attribute.");
        var selected = inline.FirstOrDefault() ?? named.GetValueOrDefault(prop.GetAttribute("type") ?? "");
        if (selected is null) return null;
        var from = selected.GetAttribute("from") ?? "";
        var selector = group.Children.FirstOrDefault(child => child.LocalName is "prop" or "state" && child.GetAttribute("name") == from);
        if (selector?.GetAttribute("type") is not { } selectorName) throw ValueType.Error(source, "A selected type requires a declared prop or state selector with finite values.");
        var selectorType = ValueType.Parse(selectorName, source);
        var choices = ValueConstraints.Read(selector, selectorType, source, (value, type) => HtmlNextCompiler.AttributeInput(value, type, source))?.Choices;
        if (choices is null || selector.LocalName == "prop" && !selector.HasAttribute("default") && !selector.HasAttribute("required"))
            throw ValueType.Error(source, "A selecting prop requires finite values and either required or a default; selecting state requires finite values.");
        var options = new List<SelectedTypeOption>();
        foreach (var child in selected.ChildNodes)
        {
            if (child is IComment || child is IText text && string.IsNullOrWhiteSpace(text.Data)) continue;
            if (child is not IElement { LocalName: "option" } option || option.GetAttribute("value") is not { } key
                || option.GetAttribute("type") is not { } written || option.Children.Any(item => item.LocalName == "option"))
                throw ValueType.Error(source, "A selected type contains options with value and type attributes.");
            var value = ExpressionValue.StoredValue(HtmlNextCompiler.AttributeInput(key, selectorType, source), selectorType);
            var type = ValueType.Parse(written, source).At(prop.GetAttribute("name") ?? "");
            if (!type.HasAttributeForm || options.Any(item => SelectedType.Same(item.Value, value)))
                throw ValueType.Error(source, "Type options require distinct selector values and HTML attribute types.");
            options.Add(new(value, type));
        }
        if (choices.Any(choice => !options.Any(option => SelectedType.Same(option.Value, ExpressionValue.StoredValue(choice, selectorType))))
            || options.Any(option => !choices.Any(choice => SelectedType.Same(option.Value, ExpressionValue.StoredValue(choice, selectorType)))))
            throw ValueType.Error(source, "A selected type covers every permitted selector value exactly once.");
        ValueType? defaultType = null;
        if (selector.LocalName == "prop" && selector.GetAttribute("default") is { } literal)
        {
            var value = ExpressionValue.StoredValue(HtmlNextCompiler.AttributeInput(literal, selectorType, source), selectorType);
            defaultType = options.FirstOrDefault(option => SelectedType.Same(option.Value, value))?.Type;
        }
        return new(from, selector.LocalName == "state", options.ToArray(), defaultType);
    }
}
