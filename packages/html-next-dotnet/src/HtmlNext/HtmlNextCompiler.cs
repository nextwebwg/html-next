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
    [GeneratedRegex(@"^\s*([^\s,]+)(?:\s*,\s*([^\s,]+))?\s+of\b\s*(.+)$", RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex EachPattern();
    [GeneratedRegex(@"^(.+)\s+as\s+(\S+)\s*$", RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex AliasPattern();
    [GeneratedRegex(@"\A[A-Za-z_$][A-Za-z0-9_$-]*\z", RegexOptions.CultureInvariant)]
    private static partial Regex ReferenceNamePattern();

    private sealed class Compiler(IHtmlTemplateElement carrier, string source, IReadOnlyDictionary<string, ComponentReference> components, HtmlNextServerAssets? assets, string sourceHash, HtmlNextServerAssets? applicationAssets = null)
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
        private readonly List<AcceptedChildListBinding> childLists = [];
        private readonly List<(string Name, int Slot, ValueType Type)> states = [];
        private InstanceRecordPlan? instance;
        private readonly Dictionary<int, IterationIndexBinding> indexLocals = [];
        public IReadOnlyDictionary<string, ScopedSlotContract> Slots => slotContracts;
        private IReadOnlyList<string> styleNames = [];
        private RootStyle? rootStyle;
        public string Tag { get; private set; } = "";
        public string? DelegatedTag => root.LocalName.Contains('-') ? root.LocalName : null;

        public bool ForwardsAttributes => !carrier.HasAttribute("noforward") || Forwarding(root);
        private bool ImplicitForwarding(IElement element) => !carrier.HasAttribute("noforward") && IsRoot(element)
            && element.Attributes.FirstOrDefault()?.Name != "$attributes";
        private static bool Forwarding(IElement element) => element.HasAttribute("$attributes") || Children(element).OfType<IElement>().Any(Forwarding);
        public Prop[] Props => props.ToArray();
        private HtmlNextModuleReference? module;
        private ExpressionStorage? expressionStorage;
        private ExpressionStorage Storage => expressionStorage ??= new();
        private static readonly HashSet<string> Void = new("area base br col embed hr img input link meta param source track wbr".Split(' '), StringComparer.Ordinal);

        public void ReadContract()
        {
            foreach (var attribute in carrier.Attributes)
                if (attribute.Name is not ("component" or "status" or "summary" or "module" or "noforward")) Unsupported(attribute.Name);
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
            if (children.FirstOrDefault(node => node is IElement { LocalName: "defs" }) is IElement defs)
            {
                var declarations = defs.ChildNodes.Where(Significant).ToArray();
                foreach (var node in declarations)
                    if (node is not IElement declaration || declaration.LocalName is not ("prop" or "state" or "computed" or "event" or "request" or "slot" or "type")) Unsupported("declaration");
                SelectedTypes.Named(defs, source);
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
                        if (attribute.Name is not ("name" or "accepts" or "as")) Unsupported("slot declaration " + attribute.Name);
                    var accepts = declaration.GetAttribute("accepts")?.Split([' ', '\t', '\n', '\r', '\f'], StringSplitOptions.RemoveEmptyEntries);
                    if (accepts is not null && (accepts.Length == 0 || accepts.Any(tag => !Regex.IsMatch(tag, @"^[a-z][a-z0-9._]*-[a-z0-9._-]*$", RegexOptions.CultureInvariant))))
                        throw ValueType.Error(source, "A slot's accepts attribute requires component tags.");
                    if (accepts is not null && Children(declaration).Any(Significant))
                        throw ValueType.Error(source, "A slot declares either accepts or prop children.");
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
                    var listName = declaration.GetAttribute("as");
                    var listSlot = -1;
                    if (listName is not null)
                    {
                        if (accepts is null) throw ValueType.Error(source, "A slot's as list requires accepts.");
                        if (!ExpressionCompiler.IsIdentifier(listName) || bindings.ContainsKey(listName))
                            throw ValueType.Error(source, $"Invalid or duplicate declaration name '{listName}'.");
                        listSlot = slots++;
                        bindings.Add(listName, (listSlot, new("list", new("unknown"))));
                    }
                    slotContracts.Add(name, new(name, members.ToArray(), accepts, listName, listSlot));
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
                            ? DeclarationTypes.Read(declaration, source, true, Default).At(name) : new ValueType("unknown", Unconstrained: true).At(name);
                        var literal = declaration.GetAttribute("value");
                        var seed = declaration.GetAttribute("from");
                        if (seed is not null && (string.IsNullOrWhiteSpace(seed) || literal is not null))
                            throw ValueType.Error(source, $"State '{name}' uses either value or a nonempty from expression.");
                        if (seed is not null) type = type.AsReference();
                        var value = literal is null ? null : type.Kind == "unknown" ? literal : Default(literal, type);
                        bindings.Add(name, (slot, type));
                        states.Add((name, slot, type));
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
                var preparationSlot = props.Any(prop => prop.Selection?.FromState == true) ? slots++ : -1;
                foreach (var prop in props)
                    if (prop.Selection is { } selection) selection.Link(bindings,
                        derived.TryGetValue(selection.From, out var item) ? item.Declaration : null, selection.FromState ? preparationSlot : -1);
                children.Remove(defs);
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
            ReadImplicitSlots(root);
        }

        private void ReadImplicitSlots(IElement element)
        {
            ExecutionStack.Check(source);
            if (!element.HasAttribute("of") && (element.LocalName == "slot" || element is IHtmlTemplateElement && element.HasAttribute("$slot")))
            {
                var name = element.GetAttribute(element.LocalName == "slot" ? "name" : "$slot") ?? "";
                slotContracts.TryAdd(name, new(name, []));
            }
            foreach (var child in Children(element).OfType<IElement>()) ReadImplicitSlots(child);
        }

        public void BindChildListTypes()
        {
            foreach (var contract in slotContracts.Values)
            {
                if (contract.As is not { } name) continue;
                var fields = new Dictionary<string, ValueType.Field>(StringComparer.Ordinal);
                foreach (var tag in contract.Accepts!)
                {
                    if (!components.TryGetValue(tag, out var component)) throw ValueType.Error(source, $"An as list accepts unknown component '{tag}'.");
                    component.EntryType ??= new("object", Fields: component.Props.Select(prop => new ValueType.Field(prop.Name, prop.Type)).ToArray());
                    foreach (var prop in component.Props)
                    {
                        var type = prop.Type.AsReference();
                        if (fields.TryGetValue(prop.Name, out var previous) && previous.Type != type) type = new("unknown");
                        fields[prop.Name] = new(prop.Name, type, Optional: true);
                    }
                }
                var listType = new ValueType("list", new("object", Fields: fields.Values.ToArray(), ChildSources: [contract]), Reference: true).AsReference();
                bindings[name] = (contract.ListSlot, listType);
                childLists.Add(new(contract.Name, contract.ListSlot, listType, contract.Accepts!));
            }
        }

        public CompiledTemplate Compile()
        {
            ReadReferences(root, new(StringComparer.Ordinal));
            foreach (var name in derived.Keys) CompileDerived(name);
            var propDefinitions = props.ToArray();
            if (assets?.Hydrate == true && assets.Client?.Adopts(Tag) == true)
                instance = new(Tag, slots++, propDefinitions, states.Select(state => new HydrationState(state.Name, state.Slot, state.Type,
                    derived.TryGetValue(state.Name, out var declaration) ? declaration.Declaration : null)).ToArray(), source, ForwardsAttributes, declarationContextSlot);
            if (assets is not null) rootStyle = new(Tag, styleNames.Select(name => new RootStyleState(name,
                bindings.ContainsKey(name) ? Expression("$" + name, bindings) : new ConstantExpression(ExpressionValue.Null))).ToArray(), source, Instance: instance);
            var operations = Element(root, bindings);
            if (expressionStorage is { Length: > 0 } scratch) scratch.AssignSlot(slots++);
            return new(Tag, propDefinitions, operations, slots, source, expressionStorage, hasComponents, initializers.ToArray(), module, declarationContextSlot, derived.Values.Select(item => item.Declaration).ToArray(), (assets ?? applicationAssets)?.Stylesheets, childLists.ToArray(), assets ?? applicationAssets, instance);
        }

        private Prop ReadProp(IElement prop, IReadOnlyCollection<Prop> declared, bool attributeOnly)
        {
            DeclarationTypes.CheckAttributes(prop, source);
            if (string.IsNullOrWhiteSpace(prop.TextContent)) throw ValueType.Error(source, "A prop requires a description.");
            var name = prop.GetAttribute("name") ?? throw ValueType.Error(source, "A prop requires a name.");
            if (!ExpressionCompiler.IsIdentifier(name)) throw ValueType.Error(source, $"Invalid prop name '{name}'.");
            if (declared.Any(item => AsciiEquals(item.Name, name))) throw ValueType.Error(source, $"Duplicate prop '{name}'.");
            var selection = attributeOnly ? SelectedTypes.Read(prop, source) : null;
            var type = selection is null ? DeclarationTypes.Read(prop, source, false, Default, javaScriptValues: !attributeOnly).At(name) : new ValueType("unknown", Reference: true, Selection: selection).At(name);
            if (attributeOnly && selection is null && !type.HasAttributeForm) throw ValueType.Error(source, "A prop and its declared fields require an HTML attribute type.");
            var literal = prop.GetAttribute("default");
            if (literal is not null && selection is not null && selection.DefaultType is null)
                throw ValueType.Error(source, "A dependent prop default requires a prop selector with a matching default.");
            var value = literal is null ? null : !attributeOnly && type.Kind == "unknown" ? literal : Default(literal, selection?.DefaultType ?? type);
            var constraints = ValueConstraints.Read(prop, type, source, Default);
            var definition = new Prop(name, type, prop.HasAttribute("required"), value, constraints, selection, literal is not null);
            if (selection?.DefaultType is { } defaultType) definition = definition with { Default = definition.Store(value, defaultType) };
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

        private sealed class DeclarationScope(Compiler compiler, IReadOnlyDictionary<string, (int Slot, ValueType Type)>? locals = null, bool declarations = true) : IDeclarationExpressionScope
        {
            private IReadOnlyDictionary<string, (int Slot, ValueType Type)> ValuesByName => locals ?? compiler.bindings;
            public (int Slot, ValueType Type) this[string key] => TryGetValue(key, out var value) ? value : throw new KeyNotFoundException(key);
            public IEnumerable<string> Keys => ValuesByName.Keys;
            public IEnumerable<(int Slot, ValueType Type)> Values => ValuesByName.Values;
            public int Count => ValuesByName.Count;
            public bool ContainsKey(string key) => ValuesByName.ContainsKey(key);
            public bool TryGetValue(string key, out (int Slot, ValueType Type) value) { compiler.CompileDerived(key); return ValuesByName.TryGetValue(key, out value); }
            public ValueExpression Read(string name, int slot, ValueType type)
            {
                if (compiler.indexLocals.TryGetValue(slot, out var local))
                {
                    if (local.Slot < 0) local.Slot = compiler.slots++;
                    return new IterationIndexExpression(local.Slot);
                }
                if (declarations && compiler.derived.TryGetValue(name, out var item) && item.Declaration.Slot == slot)
                    return new PathExpression(new(slot, [], type, RootType: type.Reference ? type : null, Declaration: item.Declaration));
                return locals is IDeclarationExpressionScope inherited ? inherited.Read(name, slot, type)
                    : new PathExpression(new(slot, [], type, RootType: type.Reference ? type : null,
                        InputContextSlot: declarations && compiler.declarationContextSlot >= 0 && slot < compiler.props.Count ? compiler.declarationContextSlot : -1));
            }
            public IEnumerator<KeyValuePair<string, (int Slot, ValueType Type)>> GetEnumerator() => ValuesByName.GetEnumerator();
            System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
        }

        private void Unsupported(string feature) => throw ValueType.Error(source, $"'{feature}' is not implemented in the measured rendering slice.");

        private IReadOnlyDictionary<string, (int Slot, ValueType Type)> ExpressionScope(Dictionary<string, (int Slot, ValueType Type)> scope)
        {
            IReadOnlyDictionary<string, (int Slot, ValueType Type)> result = projectionLocals.Count == 0 ? scope : new ProjectionExpressionScope(scope, projectionLocals);
            return scope.Values.Any(binding => binding.Slot < 0) ? new DeclarationScope(this, result, false) : result;
        }

        private ValueExpression Expression(string expression, Dictionary<string, (int Slot, ValueType Type)> scope) =>
            new ExpressionCompiler(expression, source, ExpressionScope(scope), Storage).Compile();

        private object? Default(string text, ValueType type) => AttributeInput(text, type, source);

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
            if (declarationContextSlot < 0 && props.Count > 0 && element.LocalName.Contains('-')
                && element.Attributes.Any(attribute => attribute.Name.StartsWith("from:", StringComparison.Ordinal)))
                declarationContextSlot = slots++;
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
                if (child is not IElement arm || arm.HasAttribute("$when") == arm.HasAttribute("$else"))
                    throw ValueType.Error(source, "Every direct $match child requires one $when or $else.");
                if (elseSeen) throw ValueType.Error(source, "$else must be the last $match arm.");
                elseSeen = arm.HasAttribute("$else");
                var test = elseSeen ? null : Expression(arm.GetAttribute("$when")!, scope);
                arms.Add(new(test, Element(arm, scope, true, projected)));
            }
            RenderOperation choice = new MatchChoice(arms.ToArray());
            return [instance is null || ReferenceEquals(element, root) ? choice : new HydrationRegion([choice])];
        }

        private bool IsRoot(IElement element) => ReferenceEquals(element, root) ||
            root is IHtmlTemplateElement template && ReferenceEquals(element.Parent, template.Content);

        private RenderOperation[] Element(IElement element, Dictionary<string, (int Slot, ValueType Type)> scope, bool matchArm = false, bool projected = false, bool guardHandled = false)
        {
            if (element.LocalName is "script" or "style" or "defs") Unsupported(element.LocalName);
            var fragment = element is IHtmlTemplateElement;
            if (!matchArm && (element.HasAttribute("$when") || element.HasAttribute("$else")))
                throw ValueType.Error(source, "$when and $else require a direct $match parent.");
            var structural = new[] { "$if", "$each", "$with", "$match" }.Count(element.HasAttribute);
            if (structural > 1)
                throw ValueType.Error(source, "Conflicting structural directives.");
            if (!element.HasAttribute("$each") && new[] { "$where", "$sort", "$limit", "$key" }.Any(element.HasAttribute))
                throw ValueType.Error(source, "Iteration modifiers require $each.");

            var condition = !guardHandled && element.GetAttribute("$if") is { } test ? Expression(test, scope) : null;
            ValueExpression? each = null;
            ValueExpression? where = null;
            var localSlot = -1;
            IterationPlan? iteration = null;
            if (element.GetAttribute("$each") is { } loop)
            {
                var match = EachPattern().Match(loop);
                if (!match.Success || !ExpressionCompiler.IsIdentifier(match.Groups[1].Value) || match.Groups[2].Success && !ExpressionCompiler.IsIdentifier(match.Groups[2].Value))
                    throw ValueType.Error(source, "Expected '$each=\"item of $list\"' or '$each=\"item, index of $list\"'.");
                var itemName = match.Groups[1].Value;
                var indexName = match.Groups[2].Success ? match.Groups[2].Value : null;
                if (itemName == indexName)
                    throw ValueType.Error(source, "Iteration aliases must have distinct names in their scope.");
                each = Expression(match.Groups[3].Value, scope);
                if (each.Type.Kind is not ("list" or "unknown")) throw ValueType.Error(source, "$each requires a list.");
                var outerScope = scope;
                scope = new(scope, StringComparer.Ordinal);
                localSlot = slots++;
                scope[itemName] = (localSlot, each.Type.Item ?? new("unknown"));
                if (element.GetAttribute("$where") is { } filter) where = Expression(filter, scope);
                var limit = element.GetAttribute("$limit") is { } count ? Expression(count, outerScope) : null;
                var sort = new List<IterationSort>();
                if (element.GetAttribute("$sort") is { } ordering) foreach (var part in ordering.Split(','))
                {
                    var text = part.Trim();
                    var descending = text.StartsWith('-');
                    var pathText = descending ? text[1..].Trim() : text;
                    var path = (pathText.StartsWith('$') ? pathText[1..] : pathText).Split('.');
                    if (path[0] != itemName || path.Where((step, index) => !ExpressionCompiler.IsIdentifier(step) && !(index > 0 && step.Length > 0 && step.All(char.IsAsciiDigit))).Any())
                        throw ValueType.Error(source, "$sort requires paths rooted at the loop item.");
                    sort.Add(new(Expression("$" + string.Join('.', path), scope), path.Length > 1, descending));
                }
                var indexBinding = new IterationIndexBinding();
                if (indexName is not null)
                {
                    var indexMarker = -indexLocals.Count - 1;
                    indexLocals.Add(indexMarker, indexBinding);
                    scope[indexName] = (indexMarker, ExpressionValue.NumberType);
                }
                var key = element.GetAttribute("$key") is { } identity ? Expression(identity, scope) : null;
                iteration = new(indexBinding, where, limit, key, sort.ToArray(), source);
            }
            if (IsRoot(element) && (condition is not null || each is not null)) throw ValueType.Error(source, "A component root must always select exactly one native or delegated element.");
            if (element.LocalName == "slot" || fragment && element.HasAttribute("$slot"))
            {
                var name = element.GetAttribute(fragment ? "$slot" : "name") ?? "";
                if ((!fragment && element.HasAttribute("name") || name.Length > 0) && !ExpressionCompiler.IsIdentifier(name))
                    throw ValueType.Error(source, "A slot name requires a literal expression identifier.");
                if (element.GetAttribute("of") is { } borrowed)
                {
                    var entry = Expression(borrowed, scope);
                    var origins = entry.Type.ChildSources;
                    if (entry.Type.Kind is not ("null" or "absent") &&
                        (origins is null || origins.Any(origin => !slotContracts.Values.Any(contract => ReferenceEquals(contract, origin)))))
                        throw ValueType.Error(source, "of requires an entry of this component's own as list.");
                    var outlets = new Dictionary<string, SlotOutlet>(StringComparer.Ordinal);
                    var fallback = ProjectedBody(element, scope);
                    foreach (var tag in (origins ?? []).SelectMany(origin => origin.Accepts!).Distinct(StringComparer.Ordinal))
                    {
                        if (!components[tag].Slots.TryGetValue(name, out var childSlot))
                            throw ValueType.Error(source, $"'{tag}' does not declare slot '{name}'.");
                        outlets.Add(tag, new(name, fallback, SlotArguments(element, name, scope, fragment, childSlot)));
                    }
                    return Wrap([new BorrowedSlotOutlet(entry, outlets, outlets.Values.FirstOrDefault() ?? new(name, fallback), source)], condition, each, localSlot, where, iteration);
                }
                var arguments = SlotArguments(element, name, scope, fragment);
                return Wrap([new SlotOutlet(name, ProjectedBody(element, scope), arguments)], condition, each, localSlot, where, iteration);
            }
            if (element.LocalName.Contains('-'))
                return Wrap([Invocation(element, scope, matchArm)], condition, each, localSlot, where, iteration);
            var childrenScope = scope;
            (ValueExpression Value, int Slot)? alias = null;
            if (element.GetAttribute("$with") is { } with) alias = Alias(with, scope, out childrenScope);
            if (element.GetAttribute("$match") is { } subject && !string.IsNullOrWhiteSpace(subject)) alias = Alias(subject, scope, out childrenScope);
            if (element.HasAttribute("$match") && element.HasAttribute("$value"))
                throw ValueType.Error(source, "$match cannot replace its arms with $value.");
            var operations = new List<RenderOperation>();
            if (!fragment) Add(operations, "<" + element.LocalName);
            var rootAttributes = !fragment && IsRoot(element) ? rootStyle : null;
            var attributes = element.Attributes.ToArray();
            if (element.HasAttribute("$attributes") || !fragment && (ImplicitForwarding(element) || attributes.Any(attribute => attribute.Name.StartsWith("style:", StringComparison.Ordinal))))
            {
                if (element.HasAttribute("$attributes") && (fragment || element.GetAttribute("$attributes") != "")) throw ValueType.Error(source, "$attributes is valueless and requires a rendered destination.");
                operations.Add(new ForwardedElementAttributes(ForwardingAttributes(element, scope), rootAttributes));
            }
            else
            {
            var classInstructions = new List<ClassInstruction>();
            if (attributes.Any(attribute => attribute.Name.StartsWith("class:", StringComparison.Ordinal)))
                for (var index = 0; index < attributes.Length; index++)
                {
                    var attribute = attributes[index];
                    if (attribute.Name.StartsWith("class:", StringComparison.Ordinal))
                    {
                        var token = attribute.Name[6..];
                        if (token.Length == 0 || token.Any(character => character is ' ' or '\t' or '\n' or '\r' or '\f'))
                            throw ValueType.Error(source, "A class binding requires one nonempty class token.");
                        classInstructions.Add(new(token, Expression(attribute.Value, scope), index));
                    }
                    else if (attribute.Name == "from:class") classInstructions.Add(new(null, Expression(attribute.Value, scope), index));
                }
            var classes = classInstructions.Count == 0 ? null : new ClassBinding(element, classInstructions.ToArray(), Storage, source);
            if (classes is { Constant: false }) operations.Add(new PrepareClasses(classes));
            var names = new HashSet<string>(StringComparer.Ordinal);
            var literalOrder = new List<(string Name, RenderOperation? Operation)>();
            var bindingOrder = new List<(string Name, int Position)>();
            var bindingsByName = new Dictionary<string, RenderOperation>(StringComparer.Ordinal);
            var boundNames = attributes.Where(attribute => attribute.Name.StartsWith("from:", StringComparison.Ordinal))
                .Select(attribute => AttributeName(element, attribute.Name[5..])).ToHashSet(StringComparer.Ordinal);
            for (var position = 0; position < attributes.Length; position++)
            {
                var attribute = attributes[position];
                var authoredName = QualifiedAttributeName(attribute);
                if (fragment && projected && authoredName == "slot") continue;
                if (authoredName is "$if" or "$each" or "$value" or "$with" or "$match" or "$where" or "$sort" or "$limit" or "$key" or "$ref" || matchArm && authoredName is "$when" or "$else") continue;
                if (fragment) Unsupported("attribute '" + authoredName + "' on a wrapper-free template");
                if (classes is not null && (authoredName.StartsWith("class:", StringComparison.Ordinal) || authoredName == "from:class"))
                {
                    bindingOrder.Add(("class", position));
                    continue;
                }
                if (classes is not null && authoredName == "class") { literalOrder.Add(("class", null)); continue; }
                if (authoredName.StartsWith("from:", StringComparison.Ordinal))
                {
                    var name = AttributeName(element, authoredName[5..]);
                    if (!names.Add(name)) throw ValueType.Error(source, $"Duplicate attribute '{name}'.");
                    if (name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || name is "innerhtml" or "outerhtml" or "textcontent" or "innertext" or "srcdoc") Unsupported(authoredName);
                    var path = Expression(attribute.Value, scope);
                    var kind = BoundAttribute.Kind(name);
                    var initial = attributes.FirstOrDefault(candidate => QualifiedAttributeName(candidate) == name);
                    var fallback = initial is null ? null : " " + name + "=\"" + HtmlOutput.Escape(initial.Value, true) + "\"";
                    RenderOperation operation = path is PathExpression { Type.Reference: false } bound ? new AttributeValue(name, bound.Path, kind, source, fallback)
                        : new ExpressionAttribute(name, path, kind, source, fallback);
                    bindingsByName.Add(name, rootAttributes is not null && IsStateAttribute(name) ? new RootAuthoredAttribute(name, operation, rootAttributes) : operation);
                    bindingOrder.Add((name, position));
                }
                else
                {
                    if (authoredName.StartsWith('$') || authoredName.StartsWith("on", StringComparison.OrdinalIgnoreCase)
                        || authoredName.Contains(':') && !authoredName.StartsWith("xmlns", StringComparison.Ordinal) && attribute.NamespaceUri is null) Unsupported(authoredName);
                    if (authoredName == "srcdoc" || BoundAttributeRules.IsUrl(authoredName) && BoundAttribute.ExecutableUrl(attribute.Value))
                        throw ValueType.Error(source, $"Literal attribute '{authoredName}' contains executable content.");
                    if (boundNames.Contains(authoredName)) { literalOrder.Add((authoredName, null)); continue; }
                    if (!names.Add(authoredName)) throw ValueType.Error(source, $"Duplicate attribute '{authoredName}'.");
                    if (rootAttributes is not null && authoredName == "component") continue;
                    var text = " " + authoredName + "=\"" + HtmlOutput.Escape(attribute.Value, true) + "\"";
                    RenderOperation literal = new Literal(text);
                    literalOrder.Add((authoredName, rootAttributes is not null && IsStateAttribute(authoredName)
                        ? new RootAuthoredAttribute(authoredName, literal, rootAttributes) : literal));
                }
            }
            foreach (var attribute in literalOrder)
            {
                if (attribute.Name == "class" && classes is not null) { if (classes.At(-1) is { } operation) Append(operations, [operation]); }
                else Append(operations, [attribute.Operation ?? bindingsByName[attribute.Name]]);
            }
            var literalNames = literalOrder.Select(attribute => attribute.Name).ToHashSet(StringComparer.Ordinal);
            foreach (var attribute in bindingOrder)
                if (attribute.Name == "class" && classes is not null) { if (classes.At(attribute.Position) is { } operation) Append(operations, [operation]); }
                else if (!literalNames.Contains(attribute.Name)) Append(operations, [bindingsByName[attribute.Name]]);
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
            var body = projected && !fragment ? [new ProjectionNode(operations.ToArray(), element.LocalName)] : operations.ToArray();
            if (instance is not null && element.HasAttribute("$with") && !IsRoot(element)) body = [new HydrationRegion(body)];
            return Wrap(body, condition, each, localSlot, where, iteration);
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
            Dictionary<string, AcceptedChildFilter>? filters = null;
            AcceptedChildFilter? Filter(string name)
            {
                if (!components[invocation.LocalName].Slots.TryGetValue(name, out var contract) || contract.Accepts is null) return null;
                filters ??= new(StringComparer.Ordinal);
                if (filters.TryGetValue(name, out var known)) return known;
                var targets = new HashSet<ComponentReference>();
                foreach (var (tag, candidate) in components)
                {
                    var current = tag;
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    while (seen.Add(current))
                    {
                        if (contract.Accepts.Contains(current, StringComparer.Ordinal)) { targets.Add(candidate); break; }
                        if (!components.TryGetValue(current, out var next) || next.DelegatedTag is not { } delegated) break;
                        current = delegated;
                    }
                }
                var filter = new AcceptedChildFilter(invocation.LocalName, name, contract.Accepts, targets, source);
                filters.Add(name, filter);
                return filter;
            }
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
                if (child is string text) groups.Add(new("", false, [ProjectedText(text, scope)], Filter: Filter("")));
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
                    groups.Add(new(name, template, Element(element, templateScope, projected: true, guardHandled: template), guard, template ? SourceMarkup(element) : null, locals.Count == 0 ? null : locals.ToArray(), Filter(name)));
                }
            }
            return groups.ToArray();
        }

        private ScopedSlotArguments? SlotArguments(IElement element, string name, Dictionary<string, (int Slot, ValueType Type)> scope, bool template, ScopedSlotContract? borrowed = null)
        {
            slotContracts.TryGetValue(name, out var contract);
            contract = borrowed ?? contract;
            var arguments = new ComponentArgument?[contract?.Props.Length ?? 0];
            var supplied = new HashSet<int>();
            foreach (var attribute in element.Attributes)
            {
                if (attribute.Name == (template ? "$slot" : "name") || attribute.Name is "$if" or "$each" or "$where" or "$sort" or "$limit" or "$key") continue;
                if (attribute.Name == "of" && borrowed is not null) continue;
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

        private string StyleProperty(string name)
        {
            var property = name[6..];
            if (!Regex.IsMatch(property, @"\A(?:--[a-z0-9_-]+|[a-z][a-z0-9-]*)\z", RegexOptions.CultureInvariant))
                throw ValueType.Error(source, "A style binding requires one CSS property name.");
            return property;
        }

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

        private RenderOperation[] Wrap(RenderOperation[] body, ValueExpression? condition, ValueExpression? each, int localSlot, ValueExpression? where, IterationPlan? iteration = null)
        {
            if (instance is not null && each is not null) body = [new HydrationRegion(body, "item-")];
            if (each is not null && iteration is { NeedsPlan: true }) body = [new PlannedEach(each, localSlot, body, iteration)];
            else if (each is PathExpression { Type.Reference: false } eachPath) body = [new Each(eachPath.Path, localSlot, body, where)];
            else if (each is not null) body = [new ExpressionEach(each, localSlot, body, where)];
            if (instance is not null && each is not null) body = [new HydrationRegion(body, "each-")];
            if (condition is not null) body = [condition is PathExpression { Type.Kind: "boolean", Type.Reference: false } testPath
                ? new Conditional(testPath.Path, body) : new ExpressionConditional(condition, body)];
            if (instance is not null && condition is not null) body = [new HydrationRegion(body)];
            return body;
        }

        private InvocationAttribute?[] ForwardingAttributes(IElement element, Dictionary<string, (int Slot, ValueType Type)> scope)
        {
            var result = new List<InvocationAttribute?>();
            if (ImplicitForwarding(element)) result.Add(null);
            var bound = element.Attributes.Where(attribute => attribute.Name.StartsWith("from:", StringComparison.Ordinal)).Select(attribute => attribute.Name[5..]).ToHashSet(StringComparer.Ordinal);
            foreach (var attribute in element.Attributes)
            {
                var name = QualifiedAttributeName(attribute);
                if (name == "$attributes") { result.Add(null); continue; }
                if (name is "$if" or "$each" or "$value" or "$with" or "$match" or "$where" or "$sort" or "$limit" or "$key" or "$ref" or "$when" or "$else") continue;
                if (name.StartsWith("class:", StringComparison.Ordinal))
                {
                    var token = name[6..];
                    if (token.Length == 0 || token.Any(character => character is ' ' or '\t' or '\n' or '\r' or '\f')) throw ValueType.Error(source, "A class binding requires one nonempty class token.");
                    result.Add(new(token, null, Expression(attribute.Value, scope), source, "class")); continue;
                }
                if (name.StartsWith("style:", StringComparison.Ordinal))
                {
                    var property = StyleProperty(name);
                    result.Add(new(property, null, Expression(attribute.Value, scope), source, "style")); continue;
                }
                var dynamic = name.StartsWith("from:", StringComparison.Ordinal);
                if (!dynamic && (name == "srcdoc" || BoundAttributeRules.IsUrl(name) && BoundAttribute.ExecutableUrl(attribute.Value)))
                    throw ValueType.Error(source, $"Literal attribute '{name}' contains executable content.");
                if (dynamic) name = AttributeName(element, name[5..]);
                else if (bound.Contains(name)) continue;
                if (name.StartsWith('$') || name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || name is "srcdoc" or "innerhtml" or "outerhtml" or "textcontent" or "innertext" || name.Contains(':') && attribute.NamespaceUri is null) Unsupported("attribute '" + attribute.Name + "'");
                if (!dynamic && BoundAttributeRules.IsUrl(name) && BoundAttribute.ExecutableUrl(attribute.Value)) throw ValueType.Error(source, $"Literal attribute '{name}' contains executable content.");
                result.Add(new(name, dynamic ? element.GetAttribute(name) : attribute.Value, dynamic ? Expression(attribute.Value, scope) : null, source));
            }
            return result.ToArray();
        }

        private ComponentCall Invocation(IElement element, Dictionary<string, (int Slot, ValueType Type)> scope, bool matchArm)
        {
            if (!components.TryGetValue(element.LocalName, out var target)) throw ValueType.Error(source, $"Unknown component '{element.LocalName}'.");
            var projection = Projection(element, scope);
            var arguments = new ComponentArgument?[target.Props.Length];
            var literals = new HashSet<int>();
            var bound = new HashSet<int>();
            var order = new List<int>();
            var names = new Dictionary<int, string>();
            var fallbacks = new Dictionary<int, string>();
            var forwarded = new Dictionary<string, InvocationAttribute>(StringComparer.Ordinal);
            foreach (var attribute in element.Attributes)
            {
                if (attribute.Name is "$if" or "$each" or "$where" or "$sort" or "$limit" or "$key" or "$ref" || matchArm && attribute.Name is "$when" or "$else") continue;
                if (attribute.Name == "$attributes")
                {
                    if (attribute.Value != "") throw ValueType.Error(source, "$attributes is valueless.");
                    continue;
                }
                if (attribute.Name.StartsWith("class:", StringComparison.Ordinal))
                {
                    var token = attribute.Name[6..];
                    if (token.Length == 0 || token.Any(character => character is ' ' or '\t' or '\n' or '\r' or '\f')) throw ValueType.Error(source, "A class binding requires one nonempty class token.");
                    forwarded.Add(attribute.Name, new(token, null, Expression(attribute.Value, scope), source, "class"));
                    continue;
                }
                if (attribute.Name.StartsWith("style:", StringComparison.Ordinal))
                {
                    var property = StyleProperty(attribute.Name);
                    forwarded.Add(attribute.Name, new(property, null, Expression(attribute.Value, scope), source, "style"));
                    continue;
                }
                var dynamic = attribute.Name.StartsWith("from:", StringComparison.Ordinal);
                var name = dynamic ? attribute.Name[5..] : attribute.Name;
                var index = Array.FindIndex(target.Props, prop => AsciiEquals(prop.Name, name) || AsciiEquals(prop.AttributeName, name));
                if (index < 0)
                {
                    name = AttributeName(element, name);
                    if (name is "srcdoc" or "innerhtml" or "outerhtml" or "textcontent" or "innertext"
                        || name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || name.StartsWith('$') || name.Contains(':')) Unsupported("invocation attribute '" + attribute.Name + "'");
                    if (!dynamic && BoundAttributeRules.IsUrl(name) && BoundAttribute.ExecutableUrl(attribute.Value))
                        throw ValueType.Error(source, $"Literal attribute '{name}' contains executable content.");
                    forwarded.TryGetValue(name, out var previous);
                    if (dynamic ? previous?.Expression is not null : previous?.Literal is not null) throw ValueType.Error(source, $"Duplicate invocation attribute '{name}'.");
                    forwarded[name] = new(name, dynamic ? previous?.Literal : attribute.Value, dynamic ? Expression(attribute.Value, scope) : previous?.Expression, source);
                    continue;
                }
                if (!(dynamic ? bound : literals).Add(index)) throw ValueType.Error(source, $"Duplicate component prop '{name}'.");
                if (arguments[index] is null) order.Add(index);
                var prop = target.Props[index];
                if (dynamic)
                {
                    var expression = new ExpressionCompiler(attribute.Value, source, new DeclarationScope(this, ExpressionScope(scope)), Storage, declarationContextSlot).Compile();
                    if (!prop.Type.CanBindType(expression.Type)) throw ValueType.Error(source, $"Binding '{name}' has an incompatible type.");
                    arguments[index] = new(expression, arguments[index]?.Constant, Written: arguments[index]?.Written, InputContextSlot: declarationContextSlot);
                    names[index] = name;
                }
                else
                {
                    arguments[index] = new(arguments[index]?.Expression, prop.Selection is null ? Default(attribute.Value, prop.Type) : null, Written: attribute.Value);
                    fallbacks[index] = " " + name + "=\"" + HtmlOutput.Escape(attribute.Value, true) + "\"";
                }
            }
            var propAttributes = new Dictionary<int, RenderOperation>();
            foreach (var index in order)
                if (arguments[index]!.Expression is { } expression)
                    propAttributes.Add(index, new DeferredPropAttribute(names[index], expression, target.Props[index].Type.AsReference(), BoundAttribute.Kind(names[index]), source, fallbacks.GetValueOrDefault(index), declarationContextSlot));
                else propAttributes.Add(index, new Literal(fallbacks[index]));
            var deferred = new List<RenderOperation>();
            var implicitForwarding = ImplicitForwarding(element);
            var deferredOrdered = implicitForwarding || element.HasAttribute("$attributes") || forwarded.Values.Any(attribute => attribute.Target is not null) ? new List<InvocationAttribute?>() : null;
            var attributes = new List<InvocationAttribute?>();
            if (implicitForwarding) { attributes.Add(null); deferredOrdered!.Add(null); }
            var writtenProps = new HashSet<int>();
            var writtenAttributes = new HashSet<string>(StringComparer.Ordinal);
            foreach (var attribute in element.Attributes)
            {
                if (attribute.Name == "$attributes") { attributes.Add(null); deferredOrdered?.Add(null); continue; }
                var name = attribute.Name.StartsWith("from:", StringComparison.Ordinal) ? attribute.Name[5..] : attribute.Name;
                var index = Array.FindIndex(target.Props, prop => AsciiEquals(prop.Name, name) || AsciiEquals(prop.AttributeName, name));
                if (!attribute.Name.StartsWith("from:", StringComparison.Ordinal) && !attribute.Name.StartsWith("class:", StringComparison.Ordinal) && !attribute.Name.StartsWith("style:", StringComparison.Ordinal) && (index >= 0 ? bound.Contains(index) : forwarded.GetValueOrDefault(name)?.Expression is not null)) continue;
                if (index >= 0 && writtenProps.Add(index))
                {
                    deferred.Add(propAttributes[index]);
                    deferredOrdered?.Add(new(name, element.GetAttribute(target.Props[index].AttributeName) ?? element.GetAttribute(target.Props[index].Name), null, source,
                        Prop: propAttributes[index] as DeferredPropAttribute));
                    // Preserve the prop write's position relative to the forwarding marker.
                    arguments[index] = arguments[index]! with { Position = attributes.Count };
                    attributes.Add(new(name, element.GetAttribute(target.Props[index].AttributeName) ?? element.GetAttribute(target.Props[index].Name), null, source,
                        Prop: propAttributes[index] as DeferredPropAttribute));
                }
                else if (index < 0 && forwarded.TryGetValue(name, out var entry) && writtenAttributes.Add(name))
                {
                    deferred.Add(entry);
                    deferredOrdered?.Add(entry);
                    attributes.Add(entry);
                }
            }
            if (deferredOrdered is not null) { deferred.Clear(); deferred.Add(new ForwardedElementAttributes(deferredOrdered.ToArray())); }
            hasComponents = true;
            return new(target, arguments, deferred.ToArray(), IsRoot(element) ? rootStyle : null, projection.Length == 0 ? null : projection, IsRoot(element), attributes.Count == 0 ? null : attributes.ToArray());
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


    }
    internal static bool AsciiEquals(string a, string b)
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

    internal static string AsciiLowerCase(string value)
    {
        foreach (var character in value)
            if (character is >= 'A' and <= 'Z') return string.Create(value.Length, value, static (span, source) =>
            {
                for (var index = 0; index < source.Length; index++)
                    span[index] = source[index] is >= 'A' and <= 'Z' ? (char)(source[index] + 32) : source[index];
            });
        return value;
    }

    internal static object? AttributeInput(string text, ValueType type, string source, CancellationToken cancellation = default)
    {
        object? value;
        if (type.Textual || type.Kind is "length" or "percentage" or "duration") value = text;
        else if (type.Kind == "boolean" && text is "true" or "false" or "") value = text != "false";
        else if (type.Kind is "number" or "integer" && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) value = number;
        else
        {
            var compiler = new ExpressionCompiler(text, source, new Dictionary<string, (int, ValueType)>());
            var expression = compiler.Compile();
            if (!expression.Constant || !compiler.LiteralOnly) throw ValueType.Error(source, "A default requires a literal value.");
            value = ModelValue(expression.Evaluate([]));
        }
        return value is null && type.Kind is "list" or "object" ? null : type.Bind(value, source, cancellation);
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
}
