using System.Globalization;
using System.Text;

namespace HtmlNext;

internal sealed class ExpressionCompiler(string text, string source, IReadOnlyDictionary<string, (int Slot, ValueType Type)> scope, ExpressionStorage? storage = null, int declarationContextSlot = -1)
{
    private enum TokenKind { End, Number, String, Identifier, Symbol, Dimension }
    private int position;
    private TokenKind kind;
    private string token = "";
    private bool integer;
    private static readonly ValueType Unknown = new("unknown");
    public bool LiteralOnly { get; private set; } = true;

    public ValueExpression Compile()
    {
        Next();
        var expression = Conditional();
        if (kind != TokenKind.End) Fail("Unexpected trailing input.");
        return expression;
    }

    public static bool IsIdentifier(string name)
    {
        var first = true;
        foreach (var rune in name.EnumerateRunes())
        {
            if (!IdentifierStart(rune.Value) && (first || rune.Value is < '0' or > '9')) return false;
            first = false;
        }
        return !first;
    }

    private static bool IdentifierStart(int code) => code is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or '_' or 0xB7
        or >= 0xC0 and <= 0xD6 or >= 0xD8 and <= 0xF6 or >= 0xF8 and <= 0x37D or >= 0x37F and <= 0x1FFF
        or 0x200C or 0x200D or >= 0x203F and <= 0x2040 or >= 0x2070 and <= 0x218F or >= 0x2C00 and <= 0x2FEF
        or >= 0x3001 and <= 0xD7FF or >= 0xF900 and <= 0xFDCF or >= 0xFDF0 and <= 0xFFFD or >= 0x10000 and <= 0x10FFFF;
    private static bool Space(char value) => char.IsWhiteSpace(value) || value == '\uFEFF';
    private void Fail(string message) => throw ValueType.Error(source, $"{message} In expression '{text}' at {position}.");

    private void Next()
    {
        var previousKind = kind; var previousToken = token; var previousInteger = integer;
        while (position < text.Length && Space(text[position])) position++;
        if (position == text.Length) { kind = TokenKind.End; token = ""; return; }
        var start = position;
        var character = text[position];
        if (character is '\'' or '"')
        {
            var quote = character; var value = new StringBuilder(); position++;
            while (position < text.Length && text[position] != quote)
            {
                if (text[position] == '\\' && ++position == text.Length) Fail("Unterminated string.");
                value.Append(text[position++]);
            }
            if (position == text.Length) Fail("Unterminated string.");
            position++; kind = TokenKind.String; token = value.ToString(); return;
        }
        var afterValue = previousKind is TokenKind.Identifier or TokenKind.String or TokenKind.Dimension
            || previousKind == TokenKind.Number && previousInteger || previousKind == TokenKind.Symbol && previousToken is ")" or "]" or "}";
        if (char.IsAsciiDigit(character) || character == '.' && position + 1 < text.Length && char.IsAsciiDigit(text[position + 1]) && !afterValue)
        {
            while (position < text.Length && char.IsAsciiDigit(text[position])) position++;
            if (previousToken != "." && position < text.Length && text[position] == '.')
            {
                var next = position + 1;
                if (next < text.Length && char.IsAsciiDigit(text[next]))
                {
                    position++;
                    while (position < text.Length && char.IsAsciiDigit(text[position])) position++;
                }
                else if (next == text.Length || !Rune.TryGetRuneAt(text, next, out var after) || !IdentifierStart(after.Value) && after.Value != '$') position++;
            }
            if (position < text.Length && text[position] is 'e' or 'E')
            {
                var exponent = position + 1;
                if (exponent < text.Length && text[exponent] is '+' or '-') exponent++;
                if (exponent < text.Length && char.IsAsciiDigit(text[exponent]))
                {
                    position = exponent + 1;
                    while (position < text.Length && char.IsAsciiDigit(text[position])) position++;
                }
            }
            var numberEnd = position;
            while (position < text.Length && char.IsAsciiLetter(text[position])) position++;
            if (numberEnd == position && position < text.Length && text[position] == '%')
            {
                var after = position + 1;
                while (after < text.Length && Space(text[after])) after++;
                var operand = after < text.Length && (char.IsAsciiDigit(text[after]) || text[after] == '$'
                    || text[after] == '.' && after + 1 < text.Length && char.IsAsciiDigit(text[after + 1]));
                if (!operand) position++;
            }
            token = text[start..position];
            kind = numberEnd == position ? TokenKind.Number : TokenKind.Dimension;
            integer = kind == TokenKind.Number && token.All(char.IsAsciiDigit);
            return;
        }
        if (character == '$' && (position + 1 == text.Length || text[position + 1] != '=') || Rune.TryGetRuneAt(text, position, out var first) && IdentifierStart(first.Value))
        {
            if (character == '$')
            {
                position++;
                if (position < text.Length && text[position] == '$') position++;
            }
            var nameStart = position;
            while (position < text.Length && Rune.TryGetRuneAt(text, position, out var rune)
                && (IdentifierStart(rune.Value) || position != nameStart && rune.Value is >= '0' and <= '9')) position += rune.Utf16SequenceLength;
            if (nameStart == position) Fail("Expected an identifier.");
            token = text[start..position]; kind = TokenKind.Identifier; return;
        }
        kind = TokenKind.Symbol;
        position++;
        if (position < text.Length && text[position] == '=' && character is '<' or '>' or '!' or '^' or '$' or '*') position++;
        else if (!"=<>+*/%(),.?:{}[]-".Contains(character)) Fail($"Unexpected character '{character}'.");
        token = text[start..position];
    }

    private bool Eat(string value)
    {
        if (kind != TokenKind.Symbol || token != value) return false;
        Next(); return true;
    }
    private void Expect(string value) { if (!Eat(value)) Fail($"Expected '{value}'."); }
    private static int Precedence(string value) => value switch
    {
        "or" => 1, "and" => 2, "=" or "!=" or "^=" or "$=" or "*=" => 3, "<" or "<=" or ">" or ">=" => 4,
        "+" or "-" => 5, "*" or "/" or "%" => 6, _ => 0,
    };
    private ValueExpression Binary(int minimum)
    {
        var left = Unary();
        while ((kind == TokenKind.Symbol || kind == TokenKind.Identifier) && Precedence(token) >= minimum)
        {
            var op = token; var power = Precedence(op); Next();
            LiteralOnly = false;
            var right = Binary(power + 1);
            ValueType result;
            if (op is "and" or "or") result = ExpressionValue.BooleanType;
            else if (op is "=" or "!=")
            {
                if (!Compatible(left.Type, right.Type)) Fail("Equality requires compatible operand types.");
                result = ExpressionValue.BooleanType;
            }
            else if (op is "^=" or "$=" or "*=")
            {
                Require(left, "string", "keyword"); Require(right, "string", "keyword"); result = ExpressionValue.BooleanType;
            }
            else if (op is "<" or "<=" or ">" or ">=")
            {
                Require(left, "number", "integer"); Require(right, "number", "integer"); result = ExpressionValue.BooleanType;
            }
            else result = ArithmeticType(op, left, right);
            left = Fold(op is "+" or "-" or "*" or "/" or "%" && left.Type.Kind is "number" or "integer" && right.Type.Kind is "number" or "integer"
                ? new NumericBinaryExpression(op, left, right) : new BinaryExpression(op, left, right, result));
        }
        return left;
    }
    private ValueExpression Conditional()
    {
        var test = Binary(1);
        if (!Eat("?")) return test;
        LiteralOnly = false;
        var yes = Conditional(); Expect(":"); var no = Conditional();
        return Fold(new ConditionalExpression(test, yes, no, Common(yes.Type, no.Type)));
    }
    private ValueExpression Unary()
    {
        if (kind == TokenKind.Identifier && token == "not") { LiteralOnly = false; Next(); return Fold(new UnaryExpression("not", Unary(), ExpressionValue.BooleanType)); }
        if (Eat("-"))
        {
            var operand = Unary(); Require(operand, "number", "integer", "length", "percentage", "duration");
            return Fold(new UnaryExpression("-", operand, NumericType(operand.Type)));
        }
        var target = Primary();
        while (kind == TokenKind.Symbol)
        {
            if (Eat("."))
            {
                LiteralOnly = false;
                if (kind != TokenKind.Identifier && (kind != TokenKind.Number || !integer) || token.StartsWith('$')) Fail("Expected a property name.");
                var key = token; Next(); target = Member(target, key);
            }
            else if (Eat("["))
            {
                LiteralOnly = false;
                // Keep the exact lexical key before its numeric literal could lose precision.
                var exact = kind == TokenKind.Number && integer ? token : null;
                var start = position;
                var index = Conditional();
                var direct = exact is not null && index is ConstantExpression { Value.IsNumeric: true }
                    && text.AsSpan(start, position - start).Trim().SequenceEqual("]");
                Expect("]");
                if (direct) target = Member(target, exact!);
                else if (index is ConstantExpression { Value.IsText: true } literal) target = Member(target, (string)literal.Value.Data!);
                else
                {
                    Require(index, "number", "integer", "string", "keyword");
                    var result = target.Type.Kind == "list" ? target.Type.Item! : Unknown;
                    target = Fold(new IndexExpression(target, index, result));
                }
            }
            else break;
        }
        return target;
    }

    private ValueExpression Primary()
    {
        if (kind == TokenKind.Number)
        {
            if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number)) Fail("Expected a finite numeric literal.");
            Next(); return new ConstantExpression(ExpressionValue.Numeric(number));
        }
        if (kind == TokenKind.Dimension)
        {
            if (!Dimensions.TryParse(token, out var dimension)) Fail("Unknown or invalid dimension.");
            Next(); return new ConstantExpression(dimension);
        }
        if (kind == TokenKind.String) { var value = token; Next(); return new ConstantExpression(ExpressionValue.Text(value)); }
        if (Eat("(")) { var result = Conditional(); Expect(")"); return result; }
        if (Eat("["))
        {
            var items = new List<ValueExpression>();
            if (!Eat("]"))
            {
                do { if (token == "]") break; items.Add(Conditional()); } while (Eat(","));
                Expect("]");
            }
            var item = items.Count == 0 ? Unknown : items.Select(value => value.Type).Aggregate(Common);
            return Fold(new ArrayExpression(items.ToArray(), new("list", item)));
        }
        if (Eat("{"))
        {
            var fields = new List<ValueType.Field>(); var values = new List<ValueExpression>();
            if (!Eat("}"))
            {
                do
                {
                    if (token == "}") break;
                    if (kind is not (TokenKind.String or TokenKind.Identifier) || token.StartsWith('$')) Fail("Expected an object key.");
                    var key = token; Next(); Expect(":"); var value = Conditional();
                    var previous = fields.FindIndex(field => field.Name == key);
                    if (previous < 0) { fields.Add(new(key, value.Type)); values.Add(value); }
                    else { fields[previous] = new(key, value.Type); values[previous] = value; }
                } while (Eat(","));
                Expect("}");
            }
            return Fold(new ObjectExpression(values.ToArray(), new("object", Fields: fields.ToArray())));
        }
        if (kind == TokenKind.Identifier)
        {
            var name = token; Next();
            if (name == "true" || name == "false") return new ConstantExpression(ExpressionValue.Boolean(name == "true"));
            if (name == "null") return new ConstantExpression(ExpressionValue.Null);
            if (name.StartsWith('$'))
            {
                name = name == "$$event" ? name : name[1..];
                if (!scope.TryGetValue(name, out var binding)) Fail($"Undeclared binding '{name}'.");
                return scope is IDeclarationExpressionScope declarations ? declarations.Read(name, binding.Slot, binding.Type)
                    : new PathExpression(new(binding.Slot, [], binding.Type, RootType: binding.Type.Reference ? binding.Type : null));
            }
            if (token == "(")
            {
                Next(); var arguments = new List<ValueExpression>();
                if (!Eat(")")) { do arguments.Add(Conditional()); while (Eat(",")); Expect(")"); }
                return Call(name, arguments.ToArray());
            }
            return new ConstantExpression(new(new ValueType("keyword"), name));
        }
        Fail("Expected a value.");
        throw new InvalidOperationException();
    }

    private ValueExpression Member(ValueExpression target, string key)
    {
        var type = target.Type;
        if (key == "length" && type.Kind is "list" or "string" or "keyword") return Fold(new MemberExpression(target, key, ExpressionValue.NumberType));
        var index = -1; ValueType result;
        if (type.Kind == "object")
        {
            index = Array.FindIndex(type.Fields!, field => field.Name == key);
            if (index < 0 && !type.Open) Fail($"Undeclared field '{key}'.");
            result = index < 0 ? Unknown : type.Fields![index].Type;
        }
        else if (type.Kind == "list")
        {
            result = type.Item!;
            if (ExpressionValue.CanonicalIndex(key, out var item)) index = item;
        }
        else result = Unknown;
        if (target is PathExpression path && index >= 0)
            return new PathExpression(new(path.Path.Slot, [..path.Path.Fields, index], result, [..path.Path.Keys ?? [], key], path.Path.RootType, path.Path.Declaration));
        return Fold(new MemberExpression(target, key, result));
    }

    private ValueExpression Call(string name, ValueExpression[] arguments)
    {
        LiteralOnly = false;
        var count = arguments.Length;
        var valid = name switch { "default" or "join" => count == 2, "abs" => count == 1, "round" => count is 1 or 2,
            "clamp" => count == 3, "concat" or "min" or "max" => count > 0, _ => false };
        if (!valid) Fail($"Unknown function or invalid argument count for '{name}'.");
        ValueType result;
        if (name == "default")
        {
            if (!Compatible(arguments[0].Type, arguments[1].Type)) Fail("Default requires compatible argument types.");
            result = Common(arguments[0].Type, arguments[1].Type);
        }
        else if (name == "concat")
        {
            foreach (var argument in arguments) RequireScalar(argument);
            result = ExpressionValue.StringType;
        }
        else if (name == "join")
        {
            Require(arguments[0], "list"); Require(arguments[1], "string", "keyword");
            if (arguments[0].Type.Item is { } item) RequireScalarType(item);
            result = ExpressionValue.StringType;
        }
        else
        {
            foreach (var argument in arguments) Require(argument, "number", "integer", "length", "percentage", "duration");
            for (var i = 1; i < count; i++) if (!Compatible(arguments[0].Type, arguments[i].Type)) Fail("Math arguments must have compatible types.");
            result = NumericType(arguments[0].Type);
        }
        if (name == "default" && declarationContextSlot >= 0)
            return new DeclarationDefaultExpression(arguments[0], arguments[1], result, declarationContextSlot);
        var call = Fold(new CallExpression(name, arguments, result));
        return call is CallExpression streamed && storage is not null && name is "concat" or "join"
            ? streamed with { Storage = storage, Offset = storage.Reserve(arguments.Length) } : call;
    }

    private ValueType ArithmeticType(string op, ValueExpression left, ValueExpression right)
    {
        Require(left, "number", "integer", "length", "percentage", "duration");
        Require(right, "number", "integer", "length", "percentage", "duration");
        var a = left.Type; var b = right.Type;
        if (a.Kind is "null" or "absent" or "unknown") return NumericType(b);
        if (b.Kind is "null" or "absent" or "unknown") return NumericType(a);
        var an = a.Kind is "number" or "integer"; var bn = b.Kind is "number" or "integer";
        if (an && bn) return ExpressionValue.NumberType;
        if (op is "+" or "-" && a.Kind == b.Kind || op == "*" && !an && bn || op == "/" && !an && bn) return a;
        if (op == "*" && an && !bn) return b;
        Fail("Incompatible arithmetic types."); return Unknown;
    }
    private static ValueType NumericType(ValueType type) => type.Kind == "integer" ? ExpressionValue.NumberType : type;
    private void Require(ValueExpression expression, params string[] kinds)
    {
        if (expression.Type.Kind is "unknown" or "null" or "absent" || kinds.Contains(expression.Type.Kind)) return;
        Fail($"Expected {string.Join(" or ", kinds)}, got {expression.Type.Kind}.");
    }
    public void RequireScalar(ValueExpression expression) => RequireScalarType(expression.Type);
    private void RequireScalarType(ValueType type) { if (type.Kind is "object" or "list") Fail("A scalar value is required here."); }
    internal static bool Compatible(ValueType a, ValueType b)
    {
        if (a.Kind is "unknown" or "null" or "absent" || b.Kind is "unknown" or "null" or "absent") return true;
        if (a.Kind is "number" or "integer" && b.Kind is "number" or "integer") return true;
        if (a.Kind is "string" or "keyword" && b.Kind is "string" or "keyword") return true;
        if (a.Kind != b.Kind) return false;
        if (a.Kind == "list") return Compatible(a.Item!, b.Item!);
        return a.Kind != "object" || a.Fields!.Length == b.Fields!.Length && a.Fields.All(field =>
            b.Fields!.Any(other => other.Name == field.Name && Compatible(field.Type, other.Type)));
    }
    private static ValueType Common(ValueType a, ValueType b) => a.Kind is "null" or "absent" ? b : b.Kind is "null" or "absent" ? a : Compatible(a, b) ? a : Unknown;
    private static ValueExpression Fold(ValueExpression expression)
    {
        if (!expression.Constant) return expression;
        var result = expression.Evaluate([]);
        return result.IsInvalid ? new ConstantExpression(result, expression.Type) : new ConstantExpression(Normalize(result));
    }

    private static ExpressionValue Normalize(ExpressionValue value)
    {
        if (value.Data is not ExpressionValue[] entries) return value;
        var stored = new object?[entries.Length];
        for (var i = 0; i < entries.Length; i++) stored[i] = Normalize(entries[i]).Store();
        return new(value.Type, stored);
    }
}
