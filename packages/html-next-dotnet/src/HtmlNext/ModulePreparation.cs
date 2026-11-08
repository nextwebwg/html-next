using System.Collections.ObjectModel;
using System.Text;
using System.Text.Json;

namespace HtmlNext;

/// <summary>A completed module read's selected input and produced prop value.</summary>
public sealed record HtmlNextPreparedRead(object? Input, object? Value)
{
    /// <summary>The JavaScript undefined value in a selected input, including nested fields.</summary>
    public static object UndefinedInput => BindingValueCodec.Undefined;
}

/// <summary>Prepared values and completion identities for one compiler-owned module revision.</summary>
public sealed record HtmlNextPreparedModule(string Source, IReadOnlyDictionary<string, HtmlNextPreparedRead> Reads);

/// <summary>Request-local accepted props and caller ownership before module results are applied.</summary>
public sealed class HtmlNextPreparationContext
{
    private readonly HashSet<string> supplied;

    internal HtmlNextPreparationContext(HtmlNextModuleReference module, string? source, IReadOnlyDictionary<string, object?> props,
        IEnumerable<string> supplied, CancellationToken cancellationToken)
    {
        Module = module;
        Source = source;
        Props = props;
        this.supplied = new(supplied, StringComparer.Ordinal);
        CancellationToken = cancellationToken;
    }

    public HtmlNextModuleReference Module { get; }
    public string? Source { get; }
    public IReadOnlyDictionary<string, object?> Props { get; }
    public CancellationToken CancellationToken { get; }
    public bool Supplied(string name) => supplied.Contains(name);
}

/// <summary>Supplies application-prepared module results for one logical component instance.</summary>
public delegate HtmlNextPreparedModule? HtmlNextPrepareModule(HtmlNextPreparationContext context);

internal static class PreparationValues
{
    public static IReadOnlyDictionary<string, object?> Props(Prop[] props, object?[] values, string source, CancellationToken cancellation)
    {
        var seen = new Dictionary<object, object>(ReferenceEqualityComparer.Instance);
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        for (var index = 0; index < props.Length; index++) result.Add(props[index].Name, Read(ExpressionValue.StoredValue(values[index], props[index].Type)));
        return new ReadOnlyDictionary<string, object?>(result);

        object? Read(ExpressionValue value)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            if (value.Type.Kind is not ("object" or "list")) return value.IsDimension ? value.ScalarText() : value.Store();
            if (seen.TryGetValue(value.Data!, out var previous)) return previous;
            if (value.Type.Kind == "list")
            {
                var items = new object?[value.Count];
                var list = Array.AsReadOnly(items);
                seen.Add(value.Data!, list);
                for (var index = 0; index < items.Length; index++) items[index] = Read(value.ItemUnchecked(index));
                return list;
            }
            var fields = new Dictionary<string, object?>(StringComparer.Ordinal);
            var record = new ReadOnlyDictionary<string, object?>(fields);
            seen.Add(value.Data!, record);
            for (var index = 0; index < value.Count; index++) fields.Add(value.Type.Fields![index].Name, Read(value.ItemUnchecked(index)));
            return record;
        }
    }
}

internal sealed record PreparedModuleRecord(string Source, IReadOnlyDictionary<string, (string Key, object? Value)> Reads);

internal sealed class ModulePreparationState(HtmlNextPrepareModule prepare)
{
    private Dictionary<InstanceInputs, PreparedModuleRecord>? modules;
    private Dictionary<InstanceInputs, string>? serialized;
    public HtmlNextPrepareModule Prepare { get; } = prepare;
    public PreparedModuleRecord? For(InstanceInputs inputs) => modules?.GetValueOrDefault(inputs);
    public void Record(InstanceInputs inputs, PreparedModuleRecord record) => (modules ??= []).Add(inputs, record);
    public string? Serialized(InstanceInputs inputs) => serialized?.GetValueOrDefault(inputs);
    public void RecordSerialized(InstanceInputs inputs, string value) => (serialized ??= []).Add(inputs, value);
}

internal static class PreparedModuleRecords
{
    public static string Encode(IReadOnlyDictionary<string, PreparedModuleRecord> records, string source, CancellationToken cancellation)
    {
        var text = new StringBuilder("{");
        var first = true;
        foreach (var (tag, module) in records)
        {
            cancellation.ThrowIfCancellationRequested();
            if (!first) text.Append(','); first = false;
            var reads = new Dictionary<string, object?>(StringComparer.Ordinal);
            var inputs = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var (name, read) in module.Reads)
            {
                reads.Add(name, new Dictionary<string, object?> { ["input"] = read.Key, ["value"] = read.Key, ["revision"] = 0 });
                inputs.Add(name, new Dictionary<string, object?> { ["value"] = read.Value,
                    ["status"] = new Dictionary<string, object?> { ["ready"] = true, ["pending"] = false, ["error"] = null, ["stale"] = false } });
            }
            var transfer = new Dictionary<string, object?> { ["snapshot"] = new Dictionary<string, object?> { ["source"] = module.Source, ["reads"] = reads }, ["inputs"] = inputs };
            text.Append(JsonSerializer.Serialize(tag)).Append(":[1,").Append(JsonSerializer.Serialize(module.Source)).Append(',')
                .Append(BindingValueCodec.Encode(transfer, source, cancellation)).Append(']');
        }
        return text.Append('}').ToString();
    }
}

public sealed partial class CompiledTemplate
{
    private void ApplyPreparation(object?[] values, bool[] caller, RenderContext context, InstanceInputs? record,
        CancellationToken cancellation, Action<HtmlNextDiagnostic>? onDiagnostic)
    {
        cancellation.ThrowIfCancellationRequested();
        InitializeSeeds(values);
        var expected = Assets?.PreparedModules.GetValueOrDefault(Tag);
        var scope = new HtmlNextPreparationContext(Module!, expected, PreparationValues.Props(props, values, source, cancellation),
            props.Where((_, index) => caller[index]).Select(prop => prop.Name), cancellation);
        HtmlNextPreparedModule? prepared;
        try { prepared = context.PrepareModule!(scope); }
        catch (Exception error) when (error is not (OperationCanceledException or HtmlNextException))
        {
            throw new HtmlNextException("HNCS002", $"Preparing module '{Tag}' failed.", source, error);
        }
        cancellation.ThrowIfCancellationRequested();
        if (prepared is not null)
        {
            if (string.IsNullOrEmpty(prepared.Source) || expected is not null && expected != prepared.Source || context.Interactive && expected is null)
                throw new HtmlNextException("HNCS006", $"Prepared module '{Tag}' does not match its compiled source revision.", source);
            ArgumentNullException.ThrowIfNull(prepared.Reads);
            foreach (var name in prepared.Reads.Keys)
                if (!props.Any(prop => prop.Name == name)) throw ValueType.Error(source, $"Prepared module '{Tag}' writes undeclared prop '{name}'.");
            var accepted = new Dictionary<string, (string Key, object? Value)>(StringComparer.Ordinal);
            for (var position = 0; position < props.Length; position++)
            {
                var index = bindingOrder?[position] ?? position;
                var prop = props[index];
                if (caller[index] || !prepared.Reads.TryGetValue(prop.Name, out var read)) continue;
                if (read is null) throw ValueType.Error(source, $"Prepared module '{Tag}' has no completed read for '{prop.Name}'.");
                var type = prop.EffectiveType(values);
                try
                {
                    var key = BindingValueCodec.Encode(read.Input, source, cancellation);
                    var produced = read.Value is JsonElement json ? ModelAccess.Unwrap(json) : read.Value;
                    if (produced is not null && type is null) throw ValueType.Error(source, $"Input '{prop.Name}' requires a null value while its selector is null.");
                    var value = produced is null ? prop.Default : prop.Store(type!.Bind(produced, source, cancellation), type);
                    values[index] = value;
                    if (declarations.Length > 0) ((DeclarationEvaluation)values[declarationContextSlot]!).InputReady![index] = true;
                    var stored = ExpressionValue.StoredValue(value, prop.Type);
                    accepted.Add(prop.Name, (key, stored));
                    if (record is not null) record.Values[prop.Name] = new Dictionary<string, object?>
                    {
                        ["value"] = stored, ["source"] = "value", ["present"] = true, ["provided"] = false, ["producer"] = true
                    };
                }
                catch (HtmlNextException error) when (error.Code == "HNCS001")
                {
                    onDiagnostic?.Invoke(new("HNCS004", error.Detail, source));
                }
                catch (Exception error) when (error is not (OperationCanceledException or HtmlNextException))
                {
                    throw new HtmlNextException("HNCS002", $"Reading prepared prop '{prop.Name}' failed.", source, error);
                }
            }
            if (record is not null && accepted.Count > 0) context.RecordPreparedModule(record, new(prepared.Source, accepted));
            if (accepted.Count > 0 && declarations.Length > 0) ((DeclarationEvaluation)values[declarationContextSlot]!).RefreshWaiting(declarations);
        }
        for (var index = 0; index < props.Length; index++)
            if (props[index].Required && values[index] is null) onDiagnostic?.Invoke(new("HNCS003", $"Required input '{props[index].Name}' is missing.", source));
    }
}
