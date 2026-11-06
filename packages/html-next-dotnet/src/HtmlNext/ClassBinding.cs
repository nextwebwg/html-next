using AngleSharp.Dom;

namespace HtmlNext;

internal sealed record ClassInstruction(string? Token, ValueExpression Expression, int Position);

// The parser owns literal tokenization. Requests retain the native toggle rules without a DOM:
// no-op toggles preserve written text; a mutation serializes the ordered, unique token set.
internal sealed class ClassBinding
{
    private readonly string? literal;
    private readonly string[] literalTokens;
    private readonly ClassInstruction[] instructions;
    private readonly string source;
    private readonly ExpressionStorage storage;
    private readonly int offset;
    private readonly int replacement;
    private readonly string? replacementText;
    private readonly string? constantAttribute;
    private readonly int constantPosition;
    public bool Constant { get; }

    public ClassBinding(IElement element, ClassInstruction[] instructions, ExpressionStorage storage, string source)
    {
        literal = element.GetAttribute("class");
        literalTokens = element.ClassList.ToArray();
        this.instructions = instructions; this.storage = storage; this.source = source;
        replacement = Array.FindIndex(instructions, instruction => instruction.Token is null);
        if (replacement >= 0 && instructions[replacement].Expression.Constant)
        {
            var value = instructions[replacement].Expression.Evaluate([]);
            if (BoundAttribute.ValidText(value, source) && BoundAttribute.Present(value, BoundAttributeKind.Ordinary, source)) replacementText = AttributeText(value);
        }
        Constant = instructions.All(instruction => instruction.Expression.Constant);
        if (!Constant) { offset = storage.Reserve(instructions.Length + 2); return; }
        var scratch = new ExpressionValue[instructions.Length + 2];
        Prepare([], scratch);
        constantPosition = (int)scratch[^1].Number;
        var counter = HtmlWriter.Counter();
        Write(ref counter, scratch);
        constantAttribute = string.Create(counter.Length, (Plan: this, Values: scratch), static (span, state) =>
        {
            var writer = new HtmlWriter(span); state.Plan.Write(ref writer, state.Values);
        });
    }

    public RenderOperation? At(int position) => Constant
        ? position == constantPosition && constantAttribute!.Length > 0 ? new Literal(constantAttribute) : null
        : new ClassAttribute(this, position);

    public void Prepare(object?[] values) => Prepare(values, Buffer(values));
    private Span<ExpressionValue> Buffer(object?[] values) => ((ExpressionValue[])values[storage.Slot]!).AsSpan(offset, instructions.Length + 2);

    private void Prepare(object?[] values, Span<ExpressionValue> buffer)
    {
        var text = literal;
        var present = text is not null;
        var position = present ? -1 : -2;
        for (var index = 0; index < instructions.Length; index++)
        {
            var instruction = instructions[index];
            var value = instruction.Expression.Evaluate(values);
            if (instruction.Token is null && !BoundAttribute.ValidText(value, source)) value = ExpressionValue.Invalid;
            buffer[index] = value;
            if (value.IsInvalid) continue;
            if (instruction.Token is null)
            {
                if (!BoundAttribute.Present(value, BoundAttributeKind.Ordinary, source)) { text = null; present = false; position = -2; }
                else
                {
                    text = replacementText ?? AttributeText(value);
                    if (!present) position = instruction.Position;
                    present = true;
                }
            }
            else if (value.Truthy && !present) { present = true; position = instruction.Position; }
        }
        buffer[^2] = text is null ? ExpressionValue.Null : ExpressionValue.Text(text);
        buffer[^1] = ExpressionValue.Numeric(position);
    }

    public void WriteAt(ref HtmlWriter writer, object?[] values, int position)
    {
        var buffer = Buffer(values);
        if (buffer[^1].Number == position) Write(ref writer, buffer);
    }

    private void Write(ref HtmlWriter writer, ReadOnlySpan<ExpressionValue> buffer)
    {
        if (buffer[^1].Number == -2) return;
        var text = buffer[^2].Data as string;
        var start = replacement >= 0 && !buffer[replacement].IsInvalid ? replacement + 1 : 0;
        var changed = false;
        for (var index = start; index < instructions.Length; index++)
            if (instructions[index].Token is { } token && !buffer[index].IsInvalid && buffer[index].Truthy != Contains(text, token)) { changed = true; break; }
        BoundAttribute.Open(ref writer, "class");
        if (!changed) HtmlOutput.Escape(ref writer, text.AsSpan(), true);
        else
        {
            var first = true;
            if (ReferenceEquals(text, literal))
            {
                foreach (var token in literalTokens)
                    if (Retained(token, buffer, start)) Token(ref writer, token, ref first);
            }
            else
            {
                var tokens = new ClassTokens(text.AsSpan());
                while (tokens.MoveNext())
                    if (!Contains(text.AsSpan(0, tokens.Start), tokens.Current) && Retained(tokens.Current, buffer, start))
                        Token(ref writer, tokens.Current, ref first);
            }
            for (var index = start; index < instructions.Length; index++)
                if (instructions[index].Token is { } token && !buffer[index].IsInvalid && buffer[index].Truthy && !Contains(text, token))
                    Token(ref writer, token, ref first);
        }
        writer.Write('"');
    }

    private bool Retained(ReadOnlySpan<char> token, ReadOnlySpan<ExpressionValue> buffer, int start)
    {
        for (var index = start; index < instructions.Length; index++)
            if (token.SequenceEqual(instructions[index].Token) && !buffer[index].IsInvalid) return buffer[index].Truthy;
        return true;
    }

    private static void Token(ref HtmlWriter writer, scoped ReadOnlySpan<char> token, ref bool first)
    {
        if (!first) writer.Write(' ');
        HtmlOutput.Escape(ref writer, token, true); first = false;
    }

    private static bool Contains(ReadOnlySpan<char> text, ReadOnlySpan<char> token)
    {
        var tokens = new ClassTokens(text);
        while (tokens.MoveNext()) if (tokens.Current.SequenceEqual(token)) return true;
        return false;
    }

    private string AttributeText(ExpressionValue value)
    {
        if (value.IsText) return (string)value.Data!;
        if (value.Type.Kind == "boolean") return "";
        if (value.Type.Kind != "list") return value.ScalarText();
        var counter = HtmlWriter.Counter();
        BoundAttribute.RawText(ref counter, value, source);
        return string.Create(counter.Length, (Value: value, Source: source), static (span, state) =>
        {
            var writer = new HtmlWriter(span); BoundAttribute.RawText(ref writer, state.Value, state.Source);
        });
    }

    private ref struct ClassTokens
    {
        private readonly ReadOnlySpan<char> text;
        private int next;
        public ClassTokens(ReadOnlySpan<char> text) => this.text = text;
        public int Start { get; private set; }
        public ReadOnlySpan<char> Current { get; private set; }
        public bool MoveNext()
        {
            while (next < text.Length && Space(text[next])) next++;
            Start = next;
            while (next < text.Length && !Space(text[next])) next++;
            Current = text[Start..next];
            return next > Start;
        }
        private static bool Space(char value) => value is ' ' or '\t' or '\n' or '\r' or '\f';
    }
}

internal sealed record PrepareClasses(ClassBinding Binding) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => Binding.Prepare(values);
}

internal sealed record ClassAttribute(ClassBinding Binding, int Position) : RenderOperation
{
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => Binding.WriteAt(ref writer, values, Position);
}
