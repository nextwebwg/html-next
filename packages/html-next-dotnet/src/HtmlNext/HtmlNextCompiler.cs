using System.Globalization;
using System.Text.RegularExpressions;
using AngleSharp.Dom;
using AngleSharp.Html.Dom;

namespace HtmlNext;

/// <summary>Compiles the inert measured rendering slice once. Unsupported features produce diagnostics.</summary>
public static partial class HtmlNextCompiler
{
    public static CompiledTemplate Compile(string source, string sourceName = "<source>", HtmlNextServerAssets? assets = null)
    {
        var graph = CompileResource(source, sourceName, assets);
        if (graph.Templates.Count != 1) throw ValueType.Error(sourceName, "Compile requires exactly one component; use CompileResource for multiple carriers.");
        return graph.Templates.Values.Single();
    }

    private static bool Significant(INode node) => node is not IComment && (node is not IText text || !string.IsNullOrWhiteSpace(text.Data));
    [GeneratedRegex(@"^(\S+)\s+of\s+(.+)$", RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex EachPattern();
    [GeneratedRegex(@"^(.+)\s+as\s+(\S+)\s*$", RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex AliasPattern();
    [GeneratedRegex(@"\A[A-Za-z_$][A-Za-z0-9_$-]*\z", RegexOptions.CultureInvariant)]
    private static partial Regex ReferenceNamePattern();

    private sealed class Compiler(IHtmlTemplateElement carrier, string source, IReadOnlyDictionary<string, ComponentReference> components, HtmlNextServerAssets? assets, string sourceHash)
    {
        private readonly List<Prop> props = [];
        private readonly List<LocalInitializer> initializers = [];
        private readonly Dictionary<string, (LocalDeclaration Declaration, string Source)> derived = new(StringComparer.Ordinal);
        private int declarationContextSlot = -1;
        private readonly HashSet<string> compiling = new(StringComparer.Ordinal);
        private readonly HashSet<string> compiled = new(StringComparer.Ordinal);
        private readonly Dictionary<string, (int Slot, ValueType Type)> bindings = new(StringComparer.Ordinal);
        private int slots;
        private IElement root = null!;
        private bool hasComponents;
        private readonly Dictionary<string, ScopedSlotContract> slotContracts = new(StringComparer.Ordinal);
        private readonly Dictionary<int, ScopedSlotValue> projectionLocals = [];
        public IReadOnlyDictionary<string, ScopedSlotContract> Slots => slotContracts;
        private readonly HashSet<string> outletNames = new(StringComparer.Ordinal);
        private IReadOnlyList<string> styleNames = [];
        private RootStyle? rootStyle;
        public string Tag { get; private set; } = "";
        public Prop[] Props => props.ToArray();
        private HtmlNextModuleReference? module;
        private ExpressionStorage? expressionStorage;
        private ExpressionStorage Storage => expressionStorage ??= new();
        private static readonly HashSet<string> Void = new("area base br col embed hr img input link meta param source track wbr".Split(' '), StringComparer.Ordinal);

        public void ReadContract()
        {
            foreach (var attribute in carrier.Attributes)
                if (attribute.Name is not ("component" or "status" or "summary" or "module")) Unsupported(attribute.Name);
            Tag = carrier.GetAttribute("component")!;
            if (!Regex.IsMatch(Tag, @"^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$", RegexOptions.CultureInvariant))
                throw ValueType.Error(source, "Expected a lowercase component tag containing a dash.");
            styleNames = assets?.ForComponent(Tag, sourceHash, source) ?? Array.Empty<string>();
            if (carrier.GetAttribute("module") is { } specifier)
            {
                if (string.IsNullOrWhiteSpace(specifier)) throw ValueType.Error(source, "A module reference cannot be empty.");
                module = new(Tag, source, specifier);
            }
            var children = carrier.Content.ChildNodes.Where(Significant).Where(node => node is not IElement element || !Metadata(element, source)).ToList();
            if (children.FirstOrDefault() is IElement { LocalName: "defs" } defs)
            {
                var declarations = defs.ChildNodes.Where(Significant).ToArray();
                foreach (var node in declarations)
                    if (node is not IElement declaration || declaration.LocalName is not ("prop" or "state" or "computed" or "event" or "request" or "slot")) Unsupported("declaration");
                foreach (var node in declarations.OfType<IElement>().Where(node => node.LocalName == "prop"))
                {
                    if (node is not IElement { LocalName: "prop" } prop) { Unsupported("declaration"); continue; }
                    var definition = ReadProp(prop, props, true);
                    bindings.Add(definition.Name, (slots++, definition.Type));
                    props.Add(definition);
                }
                InterfaceDeclarations.Read(declarations.OfType<IElement>(), props, source, Default);
                foreach (var declaration in declarations.OfType<IElement>().Where(node => node.LocalName == "slot"))
                {
                    var name = declaration.GetAttribute("name") ?? "";
                    if (declaration.HasAttribute("name") && !ExpressionCompiler.IsIdentifier(name)) throw ValueType.Error(source, "A slot declaration's name requires an identifier.");
                    if (slotContracts.ContainsKey(name)) throw ValueType.Error(source, $"Slot '{name}' is declared more than once.");
                    foreach (var attribute in declaration.Attributes)
                        if (attribute.Name != "name") Unsupported("slot declaration " + attribute.Name);
                    var declared = new List<Prop>();
                    var members = new List<ScopedSlotProp>();
                    foreach (var child in Children(declaration).Where(Significant))
                    {
                        if (child is not IElement { LocalName: "prop" } prop) throw ValueType.Error(source, "A slot declaration holds only prop declarations.");
                        var definition = ReadProp(prop, declared, false);
                        if (definition.Name is "name" or "of") throw ValueType.Error(source, $"Slot prop '{definition.Name}' is reserved.");
                        declared.Add(definition);
                        members.Add(new(definition, prop.HasAttribute("default")));
                    }
                    slotContracts.Add(name, new(name, members.ToArray()));
                }
                foreach (var declaration in declarations.OfType<IElement>().Where(node => node.LocalName is "state" or "computed"))
                {
                    var name = declaration.GetAttribute("name") ?? "";
                    if (!ExpressionCompiler.IsIdentifier(name) || bindings.ContainsKey(name)) throw ValueType.Error(source, $"Invalid or duplicate declaration name '{name}'.");
                    var slot = slots++;
                    if (declaration.LocalName == "state")
                    {
                        foreach (var attribute in declaration.Attributes)
                            if (attribute.Name is not ("name" or "type" or "value" or "from" or "open" or "values" or "min" or "max" or "minlength" or "maxlength")) Unsupported("state " + attribute.Name);
                        if (declaration.GetAttribute("type") is null or "unknown" && (declaration.Children.Length > 0 || declaration.Attributes.Any(attribute => attribute.Name is "open" or "values" or "min" or "max" or "minlength" or "maxlength")))
                            throw ValueType.Error(source, "An untyped state cannot declare fields or value constraints.");
                        var type = declaration.GetAttribute("type") is not (null or "unknown")
                            ? DeclarationTypes.Read(declaration, source, true, Default).At(name) : new ValueType("unknown").At(name);
                        var literal = declaration.GetAttribute("value");
                        var seed = declaration.GetAttribute("from");
                        if (seed is not null && (string.IsNullOrWhiteSpace(seed) || literal is not null))
                            throw ValueType.Error(source, $"State '{name}' uses either value or a nonempty from expression.");
                        if (seed is not null) type = type.AsReference();
                        var value = literal is null ? null : type.Kind == "unknown" ? literal : Default(literal, type);
                        bindings.Add(name, (slot, type));
                        if (seed is null) initializers.Add(new(slot, value));
                        else AddDerived(name, slot, seed, type);
                    }
                    else
                    {
                        foreach (var attribute in declaration.Attributes)
                            if (attribute.Name is not ("name" or "from")) Unsupported("computed " + attribute.Name);
                        var expression = declaration.GetAttribute("from");
                        if (string.IsNullOrWhiteSpace(expression)) throw ValueType.Error(source, $"Computed '{name}' requires a from expression.");
                        bindings.Add(name, (slot, new("unknown")));
                        AddDerived(name, slot, expression, null);
                    }
                }
                children.RemoveAt(0);
            }
            if (assets is not null) children.RemoveAll(node => node is IElement { LocalName: "style" });
            if (children.Count != 1 || children[0] is not IElement elementRoot) throw ValueType.Error(source, "Expected one native root after <defs>.");
            root = elementRoot;
            if (root.HasAttribute("$if") || root.HasAttribute("$each")) throw ValueType.Error(source, "A component root must always select exactly one native or delegated element.");
            if (root is IHtmlTemplateElement)
            {
                var arms = Children(root).Where(Significant).ToArray();
                if (root.GetAttribute("$match") != "" || arms.Length == 0
                    || arms.Any(arm => arm is not IElement choice || choice is IHtmlTemplateElement || choice.LocalName is "slot" || choice.LocalName.Contains('-'))
                    || arms[^1] is not IElement last || !last.HasAttribute("$else"))
                    throw ValueType.Error(source, "A root template requires a bare $match with native element arms ending in $else.");
            }
        }

        public CompiledTemplate Compile()
        {
            ReadReferences(root, new(StringComparer.Ordinal));
            foreach (var name in derived.Keys) CompileDerived(name);
            if (assets is not null) rootStyle = new(Tag, styleNames.Select(name => new RootStyleState(name,
                bindings.ContainsKey(name) ? Expression("$" + name, bindings) : new ConstantExpression(ExpressionValue.Null))).ToArray(), source);
            var operations = Element(root, bindings);
            if (expressionStorage is { Length: > 0 } scratch) scratch.AssignSlot(slots++);
            return new(Tag, props.ToArray(), operations, slots, source, expressionStorage, hasComponents, initializers.ToArray(), module, declarationContextSlot, derived.Values.Select(item => item.Declaration).ToArray(), assets?.Stylesheets);
        }

        private Prop ReadProp(IElement prop, IReadOnlyCollection<Prop> declared, bool attributeOnly)
        {
            foreach (var attribute in prop.Attributes)
                if (attribute.Name is not ("name" or "type" or "required" or "default" or "values" or "min" or "max" or "minlength" or "maxlength" or "open")) Unsupported(attribute.Name);
            if (string.IsNullOrWhiteSpace(prop.TextContent)) throw ValueType.Error(source, "A prop requires a description.");
            var name = prop.GetAttribute("name") ?? throw ValueType.Error(source, "A prop requires a name.");
            if (!ExpressionCompiler.IsIdentifier(name)) throw ValueType.Error(source, $"Invalid prop name '{name}'.");
            if (declared.Any(item => AsciiEquals(item.Name, name))) throw ValueType.Error(source, $"Duplicate prop '{name}'.");
            var type = DeclarationTypes.Read(prop, source, false, Default, javaScriptValues: !attributeOnly).At(name);
            if (attributeOnly && !type.HasAttributeForm) throw ValueType.Error(source, "A prop and its declared fields require an HTML attribute type.");
            var literal = prop.GetAttribute("default");
            var value = literal is null ? null : !attributeOnly && type.Kind == "unknown" ? literal : Default(literal, type);
            var constraints = ValueConstraints.Read(prop, type, source, Default);
            var definition = new Prop(name, type, prop.HasAttribute("required"), value, constraints);
            if (literal is not null)
            {
                var errors = new List<HtmlNextValidationError>();
                definition.ValidateValue(value, source, errors);
                if (errors.Count != 0) throw ValueType.Error(source, $"Default for '{name}' violates {errors[0].Reason}.");
            }
            return definition;
        }

        private void AddDerived(string name, int slot, string expression, ValueType? seedType)
        {
            if (declarationContextSlot < 0) declarationContextSlot = slots++;
            derived.Add(name, (new LocalDeclaration(name, slot, derived.Count, declarationContextSlot, seedType), expression));
        }

        private void CompileDerived(string name)
        {
            if (!derived.TryGetValue(name, out var declaration) || compiled.Contains(name)) return;
            // A syntactic back edge may be in an unread branch. Evaluation checks actual cycles.
            if (!compiling.Add(name)) return;
            ExecutionStack.Check(source);
            var scope = new DeclarationScope(this);
            var expression = new ExpressionCompiler(declaration.Source, source, scope, Storage, declarationContextSlot).Compile();
            if (declaration.Declaration.SeedType is null) bindings[name] = (declaration.Declaration.Slot, expression.Type);
            declaration.Declaration.SetExpression(expression);
            compiling.Remove(name);
            compiled.Add(name);
        }

        private sealed class DeclarationScope(Compiler compiler) : IDeclarationExpressionScope
        {
            private Dictionary<string, (int Slot, ValueType Type)> ValuesByName => compiler.bindings;
            public (int Slot, ValueType Type) this[string key] => TryGetValue(key, out var value) ? value : throw new KeyNotFoundException(key);
            public IEnumerable<string> Keys => ValuesByName.Keys;
            public IEnumerable<(int Slot, ValueType Type)> Values => ValuesByName.Values;
            public int Count => ValuesByName.Count;
            public bool ContainsKey(string key) => ValuesByName.ContainsKey(key);
            public bool TryGetValue(string key, out (int Slot, ValueType Type) value) { compiler.CompileDerived(key); return ValuesByName.TryGetValue(key, out value); }
            public ValueExpression Read(string name, int slot, ValueType type) => compiler.derived.TryGetValue(name, out var item)
                ? new PathExpression(new(slot, [], type, RootType: type.Reference ? type : null, Declaration: item.Declaration)) : new PathExpression(new(slot, [], type));
            public IEnumerator<KeyValuePair<string, (int Slot, ValueType Type)>> GetEnumerator() => ValuesByName.GetEnumerator();
            System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
        }

        private void Unsupported(string feature) => throw ValueType.Error(source, $"'{feature}' is not implemented in the measured rendering slice.");

        private IReadOnlyDictionary<string, (int Slot, ValueType Type)> ExpressionScope(Dictionary<string, (int Slot, ValueType Type)> scope) =>
            projectionLocals.Count == 0 ? scope : new ProjectionExpressionScope(scope, projectionLocals);

        private ValueExpression Expression(string expression, Dictionary<string, (int Slot, ValueType Type)> scope) =>
            new ExpressionCompiler(expression, source, ExpressionScope(scope), Storage).Compile();

        private object? Default(string text, ValueType type)
        {
            object? value;
            if (type.Kind is "string" or "keyword" or "length" or "percentage" or "duration") value = text;
            else if (type.Kind == "boolean" && text is "true" or "false" or "") value = text != "false";
            else if (type.Kind is "number" or "integer" && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) value = number;
            else
            {
                var compiler = new ExpressionCompiler(text, source, new Dictionary<string, (int, ValueType)>());
                var expression = compiler.Compile();
                if (!expression.Constant || !compiler.LiteralOnly) throw ValueType.Error(source, "A default requires a literal value.");
                value = ModelValue(expression.Evaluate([]));
            }
            return type.Bind(value, source, default);
        }

        private static object? ModelValue(ExpressionValue value)
        {
            if (value.Type.Kind == "object")
            {
                var result = new Dictionary<string, object?>(StringComparer.Ordinal);
                for (var index = 0; index < value.Count; index++) result.Add(value.Type.Fields![index].Name, ModelValue(value.Item(index)));
                return result;
            }
            if (value.Type.Kind == "list")
            {
                var result = new object?[value.Count];
                for (var index = 0; index < result.Length; index++) result[index] = ModelValue(value.Item(index));
                return result;
            }
            return value.IsDimension ? value.ScalarText() : value.Store();
        }

        private ValueExpression Scalar(string expression, Dictionary<string, (int Slot, ValueType Type)> scope)
        {
            var compiler = new ExpressionCompiler(expression, source, ExpressionScope(scope), Storage);
            var value = compiler.Compile();
            compiler.RequireScalar(value);
            return value;
        }

        private static RenderOperation TextOperation(ValueExpression expression) => expression is PathExpression { Type.Reference: false } path
            ? new TextValue(path.Path) : new ExpressionText(expression);

        private static void Add(List<RenderOperation> operations, string text)
        {
            if (operations.LastOrDefault() is Literal literal) operations[^1] = new Literal(literal.Text + text);
            else if (text.Length > 0) operations.Add(new Literal(text));
        }

        private void Text(List<RenderOperation> operations, string text, Dictionary<string, (int Slot, ValueType Type)> scope)
        {
            var start = 0;
            while (start < text.Length)
            {
                var offset = text.AsSpan(start).IndexOfAny('{', '\\');
                if (offset < 0) { Add(operations, HtmlOutput.Escape(text[start..], false)); return; }
                var open = start + offset;
                Add(operations, HtmlOutput.Escape(text[start..open], false));
                if (text[open] == '\\')
                {
                    if (open + 1 < text.Length && text[open + 1] is '{' or '\\')
                    {
                        Add(operations, text[open + 1].ToString());
                        start = open + 2;
                    }
                    else { Add(operations, "\\"); start = open + 1; }
                    continue;
                }
                var close = ExpressionEnd(text, open);
                if (close < 0) throw ValueType.Error(source, "Unclosed text expression.");
                operations.Add(TextOperation(Scalar(text[(open + 1)..close], scope)));
                start = close + 1;
            }
        }

        private static int ExpressionEnd(string text, int open)
        {
            var depth = 0;
            var quote = '\0';
            for (var index = open + 1; index < text.Length; index++)
            {
                var character = text[index];
                if (quote != '\0')
                {
                    if (character == '\\') index++;
                    else if (character == quote) quote = '\0';
                }
                else if (character is '\'' or '"') quote = character;
                else if (character == '{') depth++;
                else if (character == '}' && depth-- == 0) return index;
            }
            return -1;
        }

        private static IEnumerable<INode> Children(IElement element) => element is IHtmlTemplateElement template
            ? template.Content.ChildNodes : element.ChildNodes;

        private void ReadReferences(IElement element, HashSet<string> names)
        {
            ExecutionStack.Check(source);
            if (element.GetAttribute("$ref") is { } name)
            {
                if (!ReferenceNamePattern().IsMatch(name))
                    throw ValueType.Error(source, "A reference requires a valid non-empty name.");
                if (!names.Add(name)) throw ValueType.Error(source, $"Reference '{name}' is duplicated.");
            }
            var alternatives = ReferenceEquals(element, root) && element is IHtmlTemplateElement;
            foreach (var child in Children(element).OfType<IElement>())
                ReadReferences(child, alternatives ? new(names, StringComparer.Ordinal) : names);
        }

        private (ValueExpression Value, int Slot) Alias(string declaration, Dictionary<string, (int Slot, ValueType Type)> outer,
            out Dictionary<string, (int Slot, ValueType Type)> inner)
        {
            var match = AliasPattern().Match(declaration);
            if (!match.Success || !ExpressionCompiler.IsIdentifier(match.Groups[2].Value))
                throw ValueType.Error(source, "Expected 'expression as name'.");
            var value = Expression(match.Groups[1].Value, outer);
            var slot = slots++;
            inner = new(outer, StringComparer.Ordinal) { [match.Groups[2].Value] = (slot, value.Type) };
            return (value, slot);
        }

        private static void Append(List<RenderOperation> destination, RenderOperation[] body)
        {
            foreach (var operation in body)
                if (operation is Literal literal) Add(destination, literal.Text); else destination.Add(operation);
        }

        private RenderOperation[] Match(IElement element, Dictionary<string, (int Slot, ValueType Type)> scope, bool projected = false)
        {
            var arms = new List<MatchArm>();
            var elseSeen = false;
            foreach (var child in Children(element).Where(Significant))
            {
                if (ReferenceEquals(element, root)) outletNames.Clear();
                if (child is not IElement arm || arm.HasAttribute("$when") == arm.HasAttribute("$else"))
                    throw ValueType.Error(source, "Every direct $match child requires one $when or $else.");
                if (elseSeen) throw ValueType.Error(source, "$else must be the last $match arm.");
                elseSeen = arm.HasAttribute("$else");
                var test = elseSeen ? null : Expression(arm.GetAttribute("$when")!, scope);
                arms.Add(new(test, Element(arm, scope, true, projected)));
            }
            return [new MatchChoice(arms.ToArray())];
        }

        private bool IsRoot(IElement element) => ReferenceEquals(element, root) ||
            root is IHtmlTemplateElement template && ReferenceEquals(element.Parent, template.Content);

        private RenderOperation[] Element(IElement element, Dictionary<string, (int Slot, ValueType Type)> scope, bool matchArm = false, bool projected = false, bool guardHandled = false)
        {
            if (element.LocalName is "script" or "style" or "defs" or "select") Unsupported(element.LocalName);
            var fragment = element is IHtmlTemplateElement;
            if (!matchArm && (element.HasAttribute("$when") || element.HasAttribute("$else")))
                throw ValueType.Error(source, "$when and $else require a direct $match parent.");
            var structural = new[] { "$each", "$with", "$match" }.Count(element.HasAttribute);
            if (structural > 1 || element.HasAttribute("$if") && structural > 0 && !element.HasAttribute("$each"))
                throw ValueType.Error(source, "Conflicting structural directives.");
            if (!element.HasAttribute("$each") && element.HasAttribute("$where"))
                throw ValueType.Error(source, "$where requires $each.");

            var condition = !guardHandled && element.GetAttribute("$if") is { } test ? Expression(test, scope) : null;
            ValueExpression? each = null;
            ValueExpression? where = null;
            var localSlot = -1;
            if (element.GetAttribute("$each") is { } loop)
            {
                var match = EachPattern().Match(loop);
                if (!match.Success || !ExpressionCompiler.IsIdentifier(match.Groups[1].Value)) throw ValueType.Error(source, "Expected '$each=\"item of $list\"'.");
                each = Expression(match.Groups[2].Value, scope);
                if (each.Type.Kind is not ("list" or "unknown")) throw ValueType.Error(source, "$each requires a list.");
                scope = new(scope, StringComparer.Ordinal);
                localSlot = slots++;
                scope[match.Groups[1].Value] = (localSlot, each.Type.Item ?? new("unknown"));
                if (element.GetAttribute("$where") is { } filter) where = Expression(filter, scope);
            }
            if (IsRoot(element) && (condition is not null || each is not null)) throw ValueType.Error(source, "A component root must always select exactly one native or delegated element.");
            if (element.LocalName == "slot" || fragment && element.HasAttribute("$slot"))
            {
                var name = element.GetAttribute(fragment ? "$slot" : "name") ?? "";
                if ((!fragment && element.HasAttribute("name") || name.Length > 0) && !ExpressionCompiler.IsIdentifier(name))
                    throw ValueType.Error(source, "A slot name requires a literal expression identifier.");
                if (!outletNames.Add(name)) throw ValueType.Error(source, $"Slot '{name}' is duplicated.");
                var arguments = SlotArguments(element, name, scope, fragment);
                return Wrap([new SlotOutlet(name, ProjectedBody(element, scope), arguments)], condition, each, localSlot, where);
            }
            if (element.LocalName.Contains('-'))
                return Wrap([Invocation(element, scope, matchArm)], condition, each, localSlot, where);
            var childrenScope = scope;
            (ValueExpression Value, int Slot)? alias = null;
            if (element.GetAttribute("$with") is { } with) alias = Alias(with, scope, out childrenScope);
            if (element.GetAttribute("$match") is { } subject && !string.IsNullOrWhiteSpace(subject)) alias = Alias(subject, scope, out childrenScope);
            if (element.HasAttribute("$match") && element.HasAttribute("$value"))
                throw ValueType.Error(source, "$match cannot replace its arms with $value.");
            var operations = new List<RenderOperation>();
            if (!fragment) Add(operations, "<" + element.LocalName);
            var rootAttributes = !fragment && IsRoot(element) ? rootStyle : null;
            var names = new HashSet<string>(StringComparer.Ordinal);
            var boundNames = element.Attributes.Where(attribute => attribute.Name.StartsWith("from:", StringComparison.Ordinal))
                .Select(attribute => AttributeName(element, attribute.Name[5..])).ToHashSet(StringComparer.Ordinal);
            foreach (var attribute in element.Attributes)
            {
                var authoredName = QualifiedAttributeName(attribute);
                if (fragment && projected && authoredName == "slot") continue;
                if (authoredName is "$if" or "$each" or "$value" or "$with" or "$match" or "$where" or "$ref" || matchArm && authoredName is "$when" or "$else") continue;
                if (fragment) Unsupported("attribute '" + authoredName + "' on a wrapper-free template");
                if (authoredName.StartsWith("from:", StringComparison.Ordinal))
                {
                    var name = AttributeName(element, authoredName[5..]);
                    if (!names.Add(name)) throw ValueType.Error(source, $"Duplicate attribute '{name}'.");
                    if (name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || name is "innerhtml" or "outerhtml" or "textcontent" or "innertext" or "srcdoc") Unsupported(authoredName);
                    var path = Expression(attribute.Value, scope);
                    var kind = BoundAttribute.Kind(name);
                    var initial = element.Attributes.FirstOrDefault(candidate => QualifiedAttributeName(candidate) == name);
                    var fallback = initial is null ? null : " " + name + "=\"" + HtmlOutput.Escape(initial.Value, true) + "\"";
                    RenderOperation operation = path is PathExpression { Type.Reference: false } bound ? new AttributeValue(name, bound.Path, kind, source, fallback)
                        : new ExpressionAttribute(name, path, kind, source, fallback);
                    operations.Add(rootAttributes is not null && IsStateAttribute(name) ? new RootAuthoredAttribute(name, operation, rootAttributes) : operation);
                }
                else
                {
                    if (authoredName.StartsWith('$') || authoredName.StartsWith("on", StringComparison.OrdinalIgnoreCase)
                        || authoredName.Contains(':') && !authoredName.StartsWith("xmlns", StringComparison.Ordinal) && attribute.NamespaceUri is null) Unsupported(authoredName);
                    if (authoredName == "srcdoc" || BoundAttributeRules.IsUrl(authoredName) && BoundAttribute.ExecutableUrl(attribute.Value))
                        throw ValueType.Error(source, $"Literal attribute '{authoredName}' contains executable content.");
                    if (boundNames.Contains(authoredName)) continue;
                    if (!names.Add(authoredName)) throw ValueType.Error(source, $"Duplicate attribute '{authoredName}'.");
                    if (rootAttributes is not null && authoredName == "component") continue;
                    var text = " " + authoredName + "=\"" + HtmlOutput.Escape(attribute.Value, true) + "\"";
                    if (rootAttributes is not null && IsStateAttribute(authoredName)) operations.Add(new RootAuthoredAttribute(authoredName, new Literal(text), rootAttributes));
                    else Add(operations, text);
                }
            }
            if (rootAttributes is not null) operations.Add(element.GetAttribute("component") is { } identity
                ? rootAttributes with { AuthoredIdentity = Regex.Split(identity, @"\s+").Where(token => token.Length > 0).Distinct(StringComparer.Ordinal).ToArray() } : rootAttributes);
            if (!fragment) Add(operations, ">");
            var contents = new List<RenderOperation>();
            if (element.GetAttribute("$value") is { } value)
            {
                if (Children(element).Any(Significant)) Unsupported("$value with authored children");
                contents.Add(fragment && projected ? new ProjectionNode([TextOperation(Scalar(value, childrenScope))]) : TextOperation(Scalar(value, childrenScope)));
            }
            else if (element.HasAttribute("$match")) Append(contents, Match(element, childrenScope, fragment && projected));
            else foreach (var child in Children(element))
            {
                if (child is IText text)
                {
                    if (fragment && projected) contents.Add(ProjectedText(text.Data, childrenScope));
                    else Text(contents, text.Data, childrenScope);
                }
                else if (child is IElement nested) Append(contents, Element(nested, childrenScope, projected: fragment && projected));
                else if (child is IComment comment) Add(contents, "<!--" + comment.Data + "-->");
                else Unsupported("node");
            }
            Append(operations, alias is { } binding ? [new ScopedValue(binding.Value, binding.Slot, contents.ToArray())] : contents.ToArray());
            if (!fragment && (element.NamespaceUri != "http://www.w3.org/1999/xhtml" || !Void.Contains(element.LocalName)))
            {
                var closing = "</" + element.LocalName + ">";
                if (IsRoot(element)) operations.Add(new ProjectionRootEnd(closing));
                else Add(operations, closing);
            }
            return Wrap(projected && !fragment ? [new ProjectionNode(operations.ToArray())] : operations.ToArray(), condition, each, localSlot, where);
        }

        private ProjectionNode ProjectedText(string text, Dictionary<string, (int Slot, ValueType Type)> scope)
        {
            var operations = new List<RenderOperation>(); Text(operations, text, scope);
            return new(operations.ToArray());
        }

        private RenderOperation[] ProjectedBody(IElement element, Dictionary<string, (int Slot, ValueType Type)> scope)
        {
            var operations = new List<RenderOperation>();
            foreach (var child in Children(element))
            {
                if (child is IText text) operations.Add(ProjectedText(text.Data, scope));
                else if (child is IElement nested) Append(operations, Element(nested, scope, projected: true));
                else if (child is IComment comment) Add(operations, "<!--" + comment.Data + "-->");
            }
            return operations.ToArray();
        }

        private ProjectionGroup[] Projection(IElement invocation, Dictionary<string, (int Slot, ValueType Type)> scope)
        {
            var groups = new List<ProjectionGroup>();
            var content = new List<object>();
            foreach (var child in Children(invocation))
            {
                if (child is IText text)
                {
                    if (content.LastOrDefault() is string previous) content[^1] = previous + text.Data;
                    else content.Add(text.Data);
                }
                else if (child is IElement element) content.Add(element);
            }
            static bool Named(object node) => node is IElement element && element.HasAttribute("slot") &&
                (element.GetAttribute("slot")!.Length > 0 || element is IHtmlTemplateElement);
            for (var index = content.Count - 1; index >= 0; index--)
                if (content[index] is string text && text.All(character => character is ' ' or '\t' or '\n' or '\r' or '\f') &&
                    (index == 0 || index == content.Count - 1 || Named(content[index - 1]) || Named(content[index + 1]))) content.RemoveAt(index);
            foreach (var child in content)
            {
                if (child is string text) groups.Add(new("", false, [ProjectedText(text, scope)]));
                else if (child is IElement element)
                {
                    if (element.HasAttribute("from:slot")) throw ValueType.Error(source, "A consumer's slot assignment requires a literal name.");
                    var name = element.GetAttribute("slot") ?? "";
                    if (name.Length > 0 && !ExpressionCompiler.IsIdentifier(name)) throw ValueType.Error(source, "A consumer's slot assignment requires a literal identifier.");
                    var template = element is IHtmlTemplateElement && element.HasAttribute("slot");
                    if (template && element.HasAttribute("$each")) Unsupported("iteration on a consumer slot template");
                    if (element is IHtmlTemplateElement && !template && element.QuerySelector("[slot]") is not null) Unsupported("named projection inside a structural template");
                    var guard = template && element.GetAttribute("$if") is { } condition ? Expression(condition, scope) : null;
                    var templateScope = scope;
                    var locals = new List<ScopedSlotLocal>();
                    if (template && components[invocation.LocalName].Slots.TryGetValue(name, out var contract))
                    {
                        templateScope = new(scope, StringComparer.Ordinal);
                        for (var index = 0; index < contract.Props.Length; index++)
                        {
                            var member = contract.Props[index];
                            var prop = member.Definition;
                            var outer = !member.HasDefault && !prop.Required && scope.ContainsKey(prop.Name) ? Expression("$" + prop.Name, scope) : null;
                            var slot = slots++;
                            var type = outer is not null ? new ValueType("unknown") : prop.Type;
                            projectionLocals.Add(slot, new(slot, prop.Type, outer, type));
                            templateScope[prop.Name] = (slot, type);
                            locals.Add(new(slot, index));
                        }
                    }
                    groups.Add(new(name, template, Element(element, templateScope, projected: true, guardHandled: template), guard, template ? SourceMarkup(element) : null, locals.Count == 0 ? null : locals.ToArray()));
                }
            }
            return groups.ToArray();
        }

        private ScopedSlotArguments? SlotArguments(IElement element, string name, Dictionary<string, (int Slot, ValueType Type)> scope, bool template)
        {
            slotContracts.TryGetValue(name, out var contract);
            var arguments = new ComponentArgument?[contract?.Props.Length ?? 0];
            var supplied = new HashSet<int>();
            foreach (var attribute in element.Attributes)
            {
                if (attribute.Name == (template ? "$slot" : "name") || attribute.Name is "$if" or "$each" or "$where") continue;
                if (attribute.Name is "of" or "from:of") Unsupported("slot of");
                if (attribute.Name.StartsWith('$')) Unsupported("slot attribute '" + attribute.Name + "'");
                if (attribute.Name == "from:name" || template && attribute.Name == "name") throw ValueType.Error(source, "A slot name is a literal identifier.");
                var dynamic = attribute.Name.StartsWith("from:", StringComparison.Ordinal);
                var propName = dynamic ? attribute.Name[5..] : attribute.Name;
                var index = contract is null ? -1 : Array.FindIndex(contract.Props, prop => AsciiEquals(prop.Definition.Name, propName));
                if (index < 0) throw ValueType.Error(source, $"Slot '{name}' does not declare prop '{propName}'; add its prop declaration in defs.");
                if (!supplied.Add(index)) throw ValueType.Error(source, $"Slot '{name}' gives prop '{propName}' more than once.");
                var prop = contract!.Props[index].Definition;
                if (dynamic)
                {
                    var expression = Expression(attribute.Value, scope);
                    if (expression.Constant)
                    {
                        var value = expression.Evaluate([]);
                        object? bound = prop.Default;
                        try { if (!value.IsInvalid && !value.IsNull && !value.IsAbsent) bound = prop.Type.BindExpression(value, source, default); }
                        catch (HtmlNextException error) when (error.Code == "HNCS001")
                        {
                            throw ValueType.Error(source, $"Slot '{name}' prop '{prop.Name}' value cannot be converted: {error.Detail}");
                        }
                        arguments[index] = new(null, bound);
                    }
                    else arguments[index] = new(expression, null);
                }
                else
                {
                    object? value;
                    try { value = prop.Type.Kind == "unknown" ? attribute.Value : Default(attribute.Value, prop.Type); }
                    catch (HtmlNextException error) when (error.Code == "HNCS001")
                    {
                        throw ValueType.Error(source, $"Slot '{name}' prop '{prop.Name}' value cannot be converted: {error.Detail}");
                    }
                    var errors = new List<HtmlNextValidationError>();
                    if (value is not null) prop.Constraints?.Check(value, prop.Name, source, errors);
                    if (errors.Count > 0) throw ValueType.Error(source, $"Slot prop '{prop.Name}' value violates {errors[0].Reason}.");
                    arguments[index] = new(null, value);
                }
            }
            if (contract is null) return null;
            for (var index = 0; index < arguments.Length; index++)
                if (arguments[index] is null && contract.Props[index].Definition.Required) throw ValueType.Error(source, $"Slot '{name}' must give required prop '{contract.Props[index].Definition.Name}'.");
            return contract.Props.Length == 0 ? null : new(contract, arguments, source);
        }

        private static bool IsStateAttribute(string name) => name.StartsWith("data-", StringComparison.Ordinal) && name.EndsWith("-state", StringComparison.Ordinal);

        private string AttributeName(IElement element, string name)
        {
            try { System.Xml.XmlConvert.VerifyName(name); }
            catch (System.Xml.XmlException) { throw ValueType.Error(source, $"Invalid bound attribute name '{name}'."); }
            if (element.NamespaceUri != "http://www.w3.org/2000/svg" || name.Contains(':')) return name;
            var probe = (IHtmlTemplateElement)element.Owner!.CreateElement("template");
            probe.InnerHtml = "<svg " + name + "></svg>";
            return probe.Content.FirstElementChild!.Attributes[0]!.Name;
        }

        private static string QualifiedAttributeName(IAttr attribute) => attribute.NamespaceUri switch
        {
            "http://www.w3.org/1999/xlink" => "xlink:" + attribute.LocalName,
            "http://www.w3.org/XML/1998/namespace" => "xml:" + attribute.LocalName,
            "http://www.w3.org/2000/xmlns/" => attribute.LocalName == "xmlns" ? "xmlns" : "xmlns:" + attribute.LocalName,
            _ => attribute.Name,
        };

        private static RenderOperation[] Wrap(RenderOperation[] body, ValueExpression? condition, ValueExpression? each, int localSlot, ValueExpression? where)
        {
            if (each is PathExpression { Type.Reference: false } eachPath) body = [new Each(eachPath.Path, localSlot, body, where)];
            else if (each is not null) body = [new ExpressionEach(each, localSlot, body, where)];
            if (condition is not null) body = [condition is PathExpression { Type.Kind: "boolean", Type.Reference: false } testPath
                ? new Conditional(testPath.Path, body) : new ExpressionConditional(condition, body)];
            return body;
        }

        private ComponentCall Invocation(IElement element, Dictionary<string, (int Slot, ValueType Type)> scope, bool matchArm)
        {
            if (!components.TryGetValue(element.LocalName, out var target)) throw ValueType.Error(source, $"Unknown component '{element.LocalName}'.");
            var projection = Projection(element, scope);
            var arguments = new ComponentArgument?[target.Props.Length];
            var supplied = new HashSet<int>();
            foreach (var attribute in element.Attributes)
            {
                if (attribute.Name is "$if" or "$each" or "$where" or "$ref" || matchArm && attribute.Name is "$when" or "$else") continue;
                var dynamic = attribute.Name.StartsWith("from:", StringComparison.Ordinal);
                var name = dynamic ? attribute.Name[5..] : attribute.Name;
                var index = Array.FindIndex(target.Props, prop => AsciiEquals(prop.Name, name) || AsciiEquals(prop.AttributeName, name));
                if (index < 0) Unsupported("invocation attribute '" + attribute.Name + "'");
                if (!supplied.Add(index)) throw ValueType.Error(source, $"Duplicate component prop '{name}'.");
                var prop = target.Props[index];
                if (dynamic)
                {
                    var expression = Expression(attribute.Value, scope);
                    if (!prop.Type.CanBindType(expression.Type)) throw ValueType.Error(source, $"Binding '{name}' has an incompatible type.");
                    arguments[index] = new(expression, null);
                }
                else arguments[index] = new(null, Default(attribute.Value, prop.Type));
            }
            hasComponents = true;
            return new(target, arguments, IsRoot(element) ? rootStyle : null, projection.Length == 0 ? null : projection, IsRoot(element), SourceMarkup(element));
        }

        private static string SourceMarkup(INode node, bool inert = false)
        {
            if (node is IText text) return HtmlOutput.Escape(text.Data, false);
            if (node is IComment comment) return "<!--" + comment.Data + "-->";
            if (node is not IElement element) return "";
            var output = new System.Text.StringBuilder("<" + element.LocalName);
            foreach (var attribute in element.Attributes)
                if (inert || attribute.Name != "$ref") output.Append(' ').Append(QualifiedAttributeName(attribute)).Append("=\"").Append(HtmlOutput.Escape(attribute.Value, true)).Append('"');
            output.Append('>');
            var inertChildren = inert || element is IHtmlTemplateElement && element.HasAttribute("slot");
            foreach (var child in Children(element)) output.Append(SourceMarkup(child, inertChildren));
            if (element.NamespaceUri != "http://www.w3.org/1999/xhtml" || !Void.Contains(element.LocalName)) output.Append("</").Append(element.LocalName).Append('>');
            return output.ToString();
        }

        private static bool AsciiEquals(string a, string b)
        {
            if (a.Length != b.Length) return false;
            for (var index = 0; index < a.Length; index++)
            {
                var left = a[index] is >= 'A' and <= 'Z' ? (char)(a[index] + 32) : a[index];
                var right = b[index] is >= 'A' and <= 'Z' ? (char)(b[index] + 32) : b[index];
                if (left != right) return false;
            }
            return true;
        }
    }
}
