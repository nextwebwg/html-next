using System.Globalization;
using System.Text.RegularExpressions;

namespace HtmlNext;

public sealed class HtmlNextException(string code, string message, string source, Exception? inner = null) : Exception($"{source}: {code}: {message}", inner)
{
    public string Code { get; } = code;
    public string SourceName { get; } = source;
    public string Detail { get; } = message;
}

public sealed record HtmlNextDiagnostic(string Code, string Message, string SourceName);

/// <summary>An immutable, inert rendering plan. This experimental slice does not emit hydration records.</summary>
public sealed class CompiledTemplate
{
    private readonly Prop[] props;
    private readonly RenderOperation[] operations;
    private readonly int slots;
    private readonly string source;
    private readonly ExpressionStorage? expressionStorage;
    private readonly bool hasComponents;
    private readonly LocalInitializer[] initializers;
    private readonly int declarationContextSlot;
    private readonly LocalDeclaration[] declarations;

    internal CompiledTemplate(string tag, Prop[] props, RenderOperation[] operations, int slots, string source, ExpressionStorage? expressionStorage = null, bool hasComponents = false, LocalInitializer[]? initializers = null, HtmlNextModuleReference? module = null, int declarationContextSlot = -1, LocalDeclaration[]? declarations = null, IReadOnlyList<string>? stylesheets = null)
    {
        Tag = tag;
        Stylesheets = stylesheets ?? Array.Empty<string>();
        this.props = props;
        this.operations = operations;
        this.slots = slots;
        this.source = source;
        this.expressionStorage = expressionStorage;
        this.hasComponents = hasComponents;
        this.initializers = initializers ?? [];
        Module = module;
        this.declarationContextSlot = declarationContextSlot;
        this.declarations = declarations ?? [];
    }

    public string Tag { get; }
    public IReadOnlyList<string> Stylesheets { get; }
    public HtmlNextModuleReference? Module { get; }
    internal string SourceName => source;

    public string Render(object? inputs = null, CancellationToken cancellationToken = default, Action<HtmlNextDiagnostic>? onDiagnostic = null)
    {
        var values = Bind(inputs, cancellationToken, onDiagnostic);
        Initialize(values, cancellationToken, onDiagnostic);
        var context = hasComponents ? new RenderContext(true, onDiagnostic) : null;
        var counter = HtmlWriter.Counter(context);
        WritePlan(ref counter, values, cancellationToken);
        context?.Replay();
        return string.Create(counter.Length, (Template: this, Values: values, Token: cancellationToken, Context: context), static (destination, state) =>
        {
            var writer = new HtmlWriter(destination, state.Context);
            state.Template.WritePlan(ref writer, state.Values, state.Token);
        });
    }

    public void Write(TextWriter writer, object? inputs = null, CancellationToken cancellationToken = default, Action<HtmlNextDiagnostic>? onDiagnostic = null)
    {
        ArgumentNullException.ThrowIfNull(writer);
        var values = Bind(inputs, cancellationToken, onDiagnostic);
        Initialize(values, cancellationToken, onDiagnostic);
        var output = new HtmlWriter(writer, hasComponents ? new RenderContext(false, onDiagnostic) : null);
        WritePlan(ref output, values, cancellationToken);
    }

    public IReadOnlyList<HtmlNextValidationError> Validate(object? inputs = null, CancellationToken cancellationToken = default)
    {
        var errors = new List<HtmlNextValidationError>();
        Bind(inputs, cancellationToken, null, errors);
        return errors.Count == 0 ? Array.Empty<HtmlNextValidationError>() : errors.AsReadOnly();
    }

    private void Initialize(object?[] values, CancellationToken cancellation, Action<HtmlNextDiagnostic>? onDiagnostic)
    {
        foreach (var initializer in initializers) initializer.Initialize(values, source, cancellation);
        if (declarations.Length == 0) return;
        var evaluation = new DeclarationEvaluation(values, declarations.Length, source, cancellation, onDiagnostic);
        values[declarationContextSlot] = evaluation;
        foreach (var declaration in declarations) values[declaration.Slot] = declaration;
        foreach (var declaration in declarations)
            if (declaration.SeedType is not null) evaluation.Read(declaration);
    }

    private object?[] Bind(object? inputs, CancellationToken cancellationToken, Action<HtmlNextDiagnostic>? onDiagnostic, List<HtmlNextValidationError>? validation = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var values = validation is null ? CreateValues() : new object?[props.Length];
        BindingSnapshot? snapshot = null;
        for (var index = 0; index < props.Length; index++)
        {
            var prop = props[index];
            object? input;
            bool supplied;
            try { supplied = ModelAccess.TryRead(inputs, prop.Name, out input); }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                throw new HtmlNextException("HNCS002", $"Reading input '{prop.Name}' failed.", source, error);
            }
            var bindInput = supplied && input is not null;
            if (!bindInput) { input = prop.Default; values[index] = prop.Default; }
            var empty = validation is not null && ValueConstraints.Empty(input);
            if (validation is not null && empty) prop.ValidateValue(input, source, validation);
            if (input is null)
            {
                if (prop.Required) onDiagnostic?.Invoke(new("HNCS003", $"Required input '{prop.Name}' is missing.", source));
                continue;
            }
            if (!bindInput) continue;
            try
            {
                if (prop.Type.NeedsSnapshot) snapshot ??= new(source, cancellationToken);
                values[index] = prop.Type.Bind(input, source, cancellationToken, snapshot);
                if (validation is not null && !empty) prop.ValidateValue(values[index], source, validation);
            }
            catch (HtmlNextException error) when (error.Code == "HNCS001")
            {
                values[index] = prop.Default;
                if (validation is not null && !empty) validation.Add(new("typeMismatch", prop.Name, error.Detail, source));
                onDiagnostic?.Invoke(new("HNCS004", error.Detail, source));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                throw new HtmlNextException("HNCS002", $"Reading input '{prop.Name}' failed.", source, error);
            }
        }
        return values;
    }

    private object?[] CreateValues()
    {
        var values = new object?[slots];
        if (expressionStorage is { Length: > 0 } storage) values[storage.Slot] = new ExpressionValue[storage.Length];
        return values;
    }

    internal object?[] BindInvocation(ComponentArgument?[] arguments, object?[] parent, CancellationToken cancellation, Action<HtmlNextDiagnostic>? onDiagnostic, InvocationAttribute?[]? attributes = null, InvocationAttributeFrame? inherited = null)
    {
        var values = CreateValues();
        var marker = -1;
        var classModifiers = false;
        if (attributes is not null) for (var index = 0; index < attributes.Length; index++)
        {
            if (attributes[index] is null) marker = index;
            else if (attributes[index]!.Target == "class") classModifiers = true;
        }
        for (var index = 0; index < props.Length; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            var prop = props[index];
            var argument = arguments[index];
            string? inheritedText = null;
            var forwarded = marker >= 0 && (argument is null || argument.Position < marker) && inherited is not null &&
                (inherited.Read(prop.AttributeName, out inheritedText) || inherited.Read(prop.Name, out inheritedText));
            if (classModifiers && InvocationAttributeFrame.Matches("class", prop))
                forwarded = InvocationAttributeFrame.Read(attributes!, parent, inherited, "class", out inheritedText);
            if (forwarded) argument = null;
            var failed = false;
            values[index] = prop.Default;
            if (argument?.Expression is { } expression)
            {
                var input = expression.Evaluate(parent);
                if (input.IsInvalid)
                {
                    values[index] = argument.Constant ?? prop.Default;
                    continue;
                }
                try
                {
                    if (!input.IsNull && !input.IsAbsent) values[index] = prop.Type.BindExpression(input, source, cancellation);
                }
                catch (HtmlNextException error) when (error.Code == "HNCS001")
                {
                    failed = true;
                    values[index] = argument.Constant ?? prop.Default;
                    onDiagnostic?.Invoke(new("HNCS004", error.Detail, source));
                }
            }
            else if (argument is not null) values[index] = argument.Constant;
            else if (forwarded && inheritedText is { } text)
            {
                try { values[index] = HtmlNextCompiler.AttributeInput(text, prop.Type, source, cancellation); }
                catch (HtmlNextException error) when (error.Code == "HNCS001")
                {
                    failed = true;
                    onDiagnostic?.Invoke(new("HNCS004", error.Detail, source));
                }
            }
            if (!failed && values[index] is null && prop.Required)
                onDiagnostic?.Invoke(new("HNCS003", $"Required input '{prop.Name}' is missing.", source));
        }
        Initialize(values, cancellation, onDiagnostic);
        return values;
    }

    internal void WritePlan(ref HtmlWriter writer, object?[] values, CancellationToken cancellationToken)
    {
        foreach (var operation in operations) operation.Write(ref writer, values, cancellationToken);
    }
}

internal sealed partial record Prop(string Name, ValueType Type, bool Required, object? Default, ValueConstraints? Constraints = null)
{
    [GeneratedRegex("([a-z0-9])([A-Z])", RegexOptions.CultureInvariant)]
    private static partial Regex AttributeWords();
    public string AttributeName { get; } = HtmlNextCompiler.AsciiLowerCase(AttributeWords().Replace(Name, "$1-$2"));

    public void ValidateValue(object? value, string source, List<HtmlNextValidationError> errors)
    {
        if (ValueConstraints.Empty(value))
        {
            if (Required) errors.Add(new("valueMissing", Name, "This field is required.", source));
            return;
        }
        Constraints?.Check(value!, Name, source, errors);
    }
}
internal sealed record BoundPath(int Slot, int[] Fields, ValueType Type, string[]? Keys = null, ValueType? RootType = null, LocalDeclaration? Declaration = null)
{
    public object? Read(object?[] values)
    {
        if (Type.Reference) return ReadReference(values, true).Store();
        var value = ReadRoot(values);
        for (var step = 0; step < Fields.Length; step++)
        {
            var field = Fields[step];
            if (value is ExpressionValue aggregate)
            {
                if (aggregate.Type.Kind == "object" && Keys is not null)
                {
                    field = -1;
                    var declared = aggregate.Type.Fields!;
                    for (var index = 0; index < declared.Length; index++) if (declared[index].Name == Keys[step]) { field = index; break; }
                }
                if (aggregate.Data is ExpressionValue[] computed)
                {
                    if ((uint)field >= (uint)computed.Length) return ExpressionValue.AbsentStorage;
                    value = computed[field].Store();
                    continue;
                }
                value = aggregate.Data;
            }
            if (value is not object?[] record || (uint)field >= (uint)record.Length) return ExpressionValue.AbsentStorage;
            value = record[field];
        }
        return value;
    }

    private object? ReadRoot(object?[] values)
    {
        if (Declaration is not null) return ((DeclarationEvaluation)values[Declaration.ContextSlot]!).Observe(Declaration);
        var value = values[Slot];
        return value is LocalDeclaration declaration ? declaration.Read(values) : value;
    }

    public ExpressionValue ReadReference(object?[] values, bool conform)
    {
        var root = RootType ?? Type;
        var value = root.ReferenceValue(ExpressionValue.StoredValue(ReadRoot(values), root));
        for (var step = 0; step < Fields.Length; step++) value = value.MemberUnchecked(Keys![step]);
        return conform ? Type.CheckReference(value) : Type.ReferenceValue(value);
    }

}

internal sealed record ExpressionText(ValueExpression Expression) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => Expression.Write(ref writer, values, false);
}

internal sealed record ExpressionAttribute(string Name, ValueExpression Expression, BoundAttributeKind Kind, string Source, string? Fallback = null) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (Kind == BoundAttributeKind.Url)
        {
            if (Expression is CallExpression { Name: "concat" or "join" } call) call.WriteUrlAttribute(ref writer, values, Name, Source, Fallback);
            else BoundAttribute.Write(ref writer, Name, Expression.Evaluate(values), Kind, Source, Fallback);
            return;
        }
        var value = Expression.OutputStatus(values);
        if (!BoundAttribute.Present(value, Kind, Source)) { BoundAttribute.WriteFallback(ref writer, value, Fallback, Source); return; }
        BoundAttribute.Open(ref writer, Name);
        if (value.Type.Kind == "list") BoundAttribute.Text(ref writer, value, Source);
        else if (value.Type.Kind != "boolean" || Kind == BoundAttributeKind.EnumeratedBoolean) Expression.Write(ref writer, values, true);
        writer.Write('"');
    }
}

internal sealed record ExpressionConditional(ValueExpression Expression, RenderOperation[] Body) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation) =>
        Expression.Evaluate(values).Truthy && AnyNodes(Body, values, context, cancellation);
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (!Expression.Evaluate(values).Truthy) return;
        foreach (var operation in Body) operation.Write(ref writer, values, cancellation);
    }
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (!Expression.Evaluate(values).Truthy) return;
        foreach (var operation in Body) operation.WriteDeferred(ref writer, values, cancellation);
    }
}

internal sealed record ScopedValue(ValueExpression Expression, int Slot, RenderOperation[] Body) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation)
    {
        var previous = values[Slot];
        values[Slot] = Expression is PathExpression path ? path.Path.Read(values) : Expression.Evaluate(values).Store();
        try { return AnyNodes(Body, values, context, cancellation); }
        finally { values[Slot] = previous; }
    }
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        values[Slot] = Expression is PathExpression path ? path.Path.Read(values) : Expression.Evaluate(values).Store();
        foreach (var operation in Body) operation.Write(ref writer, values, cancellation);
        values[Slot] = null;
    }
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        values[Slot] = Expression is PathExpression path ? path.Path.Read(values) : Expression.Evaluate(values).Store();
        foreach (var operation in Body) operation.WriteDeferred(ref writer, values, cancellation);
        values[Slot] = null;
    }
}

internal sealed record MatchArm(ValueExpression? Test, RenderOperation[] Body);
internal sealed record MatchChoice(MatchArm[] Arms) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation)
    {
        foreach (var arm in Arms)
            if (arm.Test is null || arm.Test.Evaluate(values).Truthy) return AnyNodes(arm.Body, values, context, cancellation);
        return false;
    }
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        foreach (var arm in Arms)
        {
            if (arm.Test is not null && !arm.Test.Evaluate(values).Truthy) continue;
            foreach (var operation in arm.Body) operation.Write(ref writer, values, cancellation);
            return;
        }
    }
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        foreach (var arm in Arms)
        {
            if (arm.Test is not null && !arm.Test.Evaluate(values).Truthy) continue;
            foreach (var operation in arm.Body) operation.WriteDeferred(ref writer, values, cancellation);
            return;
        }
    }
}

internal sealed record ExpressionEach(ValueExpression Expression, int Slot, RenderOperation[] Body, ValueExpression? Where = null) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation)
    {
        var list = Expression.Evaluate(values);
        if (list.Type.Kind != "list") return false;
        var previous = values[Slot];
        try
        {
            for (var index = 0; index < list.Count; index++)
            {
                cancellation.ThrowIfCancellationRequested();
                values[Slot] = list.Type.Reference ? list.ItemUnchecked(index).Store() : list.Data is object?[] entries ? entries[index] : list.Item(index).Store();
                if ((Where is null || Where.Evaluate(values).Truthy) && AnyNodes(Body, values, context, cancellation)) return true;
            }
            return false;
        }
        finally { values[Slot] = previous; }
    }
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        var list = Expression.Evaluate(values);
        if (list.Type.Kind != "list") return;
        for (var index = 0; index < list.Count; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            values[Slot] = list.Type.Reference ? list.ItemUnchecked(index).Store() : list.Data is object?[] entries ? entries[index] : list.Item(index).Store();
            if (Where is not null && !Where.Evaluate(values).Truthy) continue;
            foreach (var operation in Body) operation.Write(ref writer, values, cancellation);
        }
        values[Slot] = null;
    }
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        var list = Expression.Evaluate(values);
        if (list.Type.Kind != "list") return;
        for (var index = 0; index < list.Count; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            values[Slot] = list.Type.Reference ? list.ItemUnchecked(index).Store() : list.Data is object?[] entries ? entries[index] : list.Item(index).Store();
            if (Where is not null && !Where.Evaluate(values).Truthy) continue;
            foreach (var operation in Body) operation.WriteDeferred(ref writer, values, cancellation);
        }
        values[Slot] = null;
    }
}

internal abstract record RenderOperation
{
    public abstract void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation);
    public virtual void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => Write(ref writer, values, cancellation);
    public virtual bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation) => false;
    public static bool AnyNodes(RenderOperation[] operations, object?[] values, RenderContext? context, CancellationToken cancellation)
    {
        foreach (var operation in operations)
        {
            cancellation.ThrowIfCancellationRequested();
            if (operation.HasNodes(values, context, cancellation)) return true;
        }
        return false;
    }
}

internal sealed record Literal(string Text) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => writer.Write(Text);
}

internal sealed record TextValue(BoundPath Path) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => HtmlOutput.Value(ref writer, Path.Read(values), false);
}

internal sealed record AttributeValue(string Name, BoundPath Path, BoundAttributeKind Kind, string Source, string? Fallback = null) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        var value = Path.Read(values);
        BoundAttribute.Write(ref writer, Name, ExpressionValue.Stored(value, Path.Type), Kind, Source, Fallback);
    }
}

internal sealed record Conditional(BoundPath Path, RenderOperation[] Body) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation) =>
        Path.Read(values) is true && AnyNodes(Body, values, context, cancellation);
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (Path.Read(values) is not true) return;
        foreach (var operation in Body) operation.Write(ref writer, values, cancellation);
    }
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        if (Path.Read(values) is not true) return;
        foreach (var operation in Body) operation.WriteDeferred(ref writer, values, cancellation);
    }
}

internal sealed record Each(BoundPath Path, int Slot, RenderOperation[] Body, ValueExpression? Where = null) : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation)
    {
        var value = Path.Read(values);
        var items = value as object?[] ?? (value is ExpressionValue { Type.Kind: "list", Data: object?[] computed } ? computed : null);
        if (items is null) return false;
        var previous = values[Slot];
        try
        {
            foreach (var item in items)
            {
                cancellation.ThrowIfCancellationRequested();
                values[Slot] = item;
                if ((Where is null || Where.Evaluate(values).Truthy) && AnyNodes(Body, values, context, cancellation)) return true;
            }
            return false;
        }
        finally { values[Slot] = previous; }
    }
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        var value = Path.Read(values);
        var items = value as object?[] ?? (value is ExpressionValue { Type.Kind: "list", Data: object?[] computed } ? computed : null);
        if (items is null) return;
        foreach (var item in items)
        {
            cancellation.ThrowIfCancellationRequested();
            values[Slot] = item;
            if (Where is not null && !Where.Evaluate(values).Truthy) continue;
            foreach (var operation in Body) operation.Write(ref writer, values, cancellation);
        }
        values[Slot] = null;
    }
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation)
    {
        var value = Path.Read(values);
        var items = value as object?[] ?? (value is ExpressionValue { Type.Kind: "list", Data: object?[] computed } ? computed : null);
        if (items is null) return;
        foreach (var item in items)
        {
            cancellation.ThrowIfCancellationRequested();
            values[Slot] = item;
            if (Where is not null && !Where.Evaluate(values).Truthy) continue;
            foreach (var operation in Body) operation.WriteDeferred(ref writer, values, cancellation);
        }
        values[Slot] = null;
    }
}

internal ref struct HtmlWriter
{
    private readonly TextWriter? output;
    private readonly Span<char> destination;
    private readonly bool counting;
    public int Length { get; private set; }
    public RenderContext? Context { get; }

    private HtmlWriter(bool counting, RenderContext? context) { this.counting = counting; output = null; destination = default; Length = 0; Context = context; }
    public HtmlWriter(TextWriter output, RenderContext? context = null) { this.output = output; destination = default; counting = false; Length = 0; Context = context; }
    public HtmlWriter(Span<char> destination, RenderContext? context = null) { this.destination = destination; output = null; counting = false; Length = 0; Context = context; }
    public static HtmlWriter Counter(RenderContext? context = null) => new(true, context);

    public void Write(string? text) => Write(text.AsSpan());
    public void Write(char character)
    {
        if (!counting)
        {
            if (output is not null) output.Write(character);
            else destination[Length] = character;
        }
        Length = checked(Length + 1);
    }

    public void Write(scoped ReadOnlySpan<char> text)
    {
        if (!counting)
        {
            if (output is not null) output.Write(text);
            else text.CopyTo(destination.Slice(Length, text.Length));
        }
        Length = checked(Length + text.Length);
    }
}

internal static class HtmlOutput
{
    public static void Value(ref HtmlWriter writer, object? value, bool attribute)
    {
        if (ReferenceEquals(value, ExpressionValue.AbsentStorage) || ReferenceEquals(value, ExpressionValue.InvalidStorage)) return;
        switch (value)
        {
            case null: return;
            case string text: Escape(ref writer, text, attribute); return;
            case bool boolean: writer.Write(boolean ? "true" : "false"); return;
            case double number: Number(ref writer, number); return;
            case sbyte or byte or short or ushort or int or uint or long or ulong or float or decimal:
                Number(ref writer, Convert.ToDouble(value, CultureInfo.InvariantCulture)); return;
            case ExpressionValue expression: expression.Write(ref writer, attribute); return;
            default: throw new InvalidOperationException("Only scalar values can be written as text.");
        }
    }

    internal static void Number(ref HtmlWriter writer, double value)
    {
        if (value == 0) { writer.Write('0'); return; }
        Span<char> buffer = stackalloc char[32];
        if (!value.TryFormat(buffer, out var written, "R", CultureInfo.InvariantCulture)) throw new InvalidOperationException("Number formatting failed.");
        var text = buffer[..written];
        var position = text.IndexOfAny('E', 'e');
        if (position < 0) { writer.Write(text); return; }
        var exponent = int.Parse(text[(position + 1)..], CultureInfo.InvariantCulture);
        if (exponent < -6 || exponent >= 21)
        {
            writer.Write(text[..position]);
            writer.Write('e');
            if (exponent >= 0) writer.Write('+');
            Span<char> digits = stackalloc char[8];
            if (!exponent.TryFormat(digits, out var count, provider: CultureInfo.InvariantCulture)) throw new InvalidOperationException("Exponent formatting failed.");
            writer.Write(digits[..count]);
            return;
        }
        var negative = text[0] == '-';
        Span<char> significant = stackalloc char[24];
        var length = 0;
        foreach (var character in text[(negative ? 1 : 0)..position])
            if (character != '.') significant[length++] = character;
        var point = exponent + 1;
        if (negative) writer.Write('-');
        if (point <= 0)
        {
            writer.Write("0.");
            for (var index = 0; index < -point; index++) writer.Write('0');
            writer.Write(significant[..length]);
        }
        else if (point >= length)
        {
            writer.Write(significant[..length]);
            for (var index = length; index < point; index++) writer.Write('0');
        }
        else
        {
            writer.Write(significant[..point]);
            writer.Write('.');
            writer.Write(significant[point..length]);
        }
    }

    public static string Escape(string text, bool attribute)
    {
        using var writer = new StringWriter(CultureInfo.InvariantCulture);
        var output = new HtmlWriter(writer);
        Escape(ref output, text, attribute);
        return writer.ToString();
    }

    public static void Escape(ref HtmlWriter writer, scoped ReadOnlySpan<char> text, bool attribute)
    {
        var start = 0;
        for (var index = 0; index < text.Length; index++)
        {
            var escaped = text[index] switch
            {
                '&' => "&amp;", '<' => "&lt;", '>' => "&gt;", '"' when attribute => "&quot;", _ => null
            };
            if (escaped is null) continue;
            writer.Write(text.Slice(start, index - start));
            writer.Write(escaped);
            start = index + 1;
        }
        writer.Write(text[start..]);
    }
}
