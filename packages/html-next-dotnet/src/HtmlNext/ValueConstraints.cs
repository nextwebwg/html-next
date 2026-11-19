using System.Globalization;
using AngleSharp.Dom;

namespace HtmlNext;

public sealed record HtmlNextValidationError(string Reason, string Path, string Message, string SourceName);

internal sealed record ValueConstraints(object?[]? Choices, double? Min, double? Max, int? MinLength, int? MaxLength)
{
    public static ValueConstraints? Read(IElement element, ValueType type, string source, Func<string, ValueType, object?> parse)
    {
        object?[]? choices = null;
        if (element.GetAttribute("values") is { } values)
        {
            if (type.Kind is "list" or "object" or "unknown") throw ValueType.Error(source, "values requires a scalar type.");
            var entries = values.Split(',').Select(value => value.Trim()).ToArray();
            if (entries.Any(value => value.Length == 0)) throw ValueType.Error(source, "A values constraint requires nonempty entries.");
            choices = entries.Select(value => parse(value, type)).ToArray();
        }
        double? Bound(string name)
        {
            if (element.GetAttribute(name) is not { } text) return null;
            if (type.Kind is not ("number" or "integer") || !double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number))
                throw ValueType.Error(source, $"Invalid {name} constraint for '{type.Kind}'.");
            return number;
        }
        int? Length(string name)
        {
            if (element.GetAttribute(name) is not { } text) return null;
            if (type.Kind is not ("string" or "keyword") || !int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var count))
                throw ValueType.Error(source, $"Invalid {name} constraint for '{type.Kind}'.");
            return count;
        }
        var min = Bound("min"); var max = Bound("max");
        var minLength = Length("minlength"); var maxLength = Length("maxlength");
        return choices is null && min is null && max is null && minLength is null && maxLength is null ? null
            : new(choices, min, max, minLength, maxLength);
    }

    public static bool Empty(object? value) => value is null or "";

    [Flags]
    private enum Failure { None = 0, Underflow = 1, Overflow = 2, Short = 4, Long = 8, Choice = 16 }

    private Failure Failures(object value)
    {
        if (Empty(value)) return Failure.None;
        var failures = Failure.None;
        if (Min is not null || Max is not null)
        {
            var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            if (Min is { } min && number < min) failures |= Failure.Underflow;
            if (Max is { } max && number > max) failures |= Failure.Overflow;
        }
        if (value is string text)
        {
            if (MinLength is { } min && text.Length < min) failures |= Failure.Short;
            if (MaxLength is { } max && text.Length > max) failures |= Failure.Long;
        }
        if (Choices is not null)
        {
            var found = false;
            foreach (var choice in Choices) if (SameScalar(choice, value)) { found = true; break; }
            if (!found) failures |= Failure.Choice;
        }
        return failures;
    }

    public bool Accepts(object value) => Failures(value) == Failure.None;

    public void Check(object value, string path, string source, List<HtmlNextValidationError> errors)
    {
        var failures = Failures(value);
        if ((failures & Failure.Underflow) != 0) errors.Add(new("rangeUnderflow", path, $"Value must be at least {Min!.Value.ToString(CultureInfo.InvariantCulture)}.", source));
        if ((failures & Failure.Overflow) != 0) errors.Add(new("rangeOverflow", path, $"Value must be at most {Max!.Value.ToString(CultureInfo.InvariantCulture)}.", source));
        if ((failures & Failure.Short) != 0) errors.Add(new("tooShort", path, $"Use at least {MinLength} characters.", source));
        if ((failures & Failure.Long) != 0) errors.Add(new("tooLong", path, $"Use at most {MaxLength} characters.", source));
        if ((failures & Failure.Choice) != 0) errors.Add(new("typeMismatch", path, "Value is outside the permitted choices.", source));
    }

    private static bool SameScalar(object? a, object b) => a is double expected && b is sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal
        ? expected == Convert.ToDouble(b, CultureInfo.InvariantCulture) : Equals(a, b);
}
