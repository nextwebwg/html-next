using System.Text;
using System.Text.Json;

namespace HtmlNext;

public sealed record HtmlNextRenderOptions
{
    /// <summary>Emit instance records for components selected by the matching compiler-owned client plan.</summary>
    public bool Interactive { get; init; }
    /// <summary>Supplies settled module data, preserving initialized state and completing waiting seeds.</summary>
    public HtmlNextPrepareModule? PrepareModule { get; init; }
}

internal sealed record HydrationRegion(RenderOperation[] Body, string Prefix = "") : RenderOperation
{
    public override bool HasNodes(object?[] values, RenderContext? context, CancellationToken cancellation) => AnyNodes(Body, values, context, cancellation);
    public override void Write(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WriteBody(ref writer, values, cancellation, false);
    public override void WriteDeferred(ref HtmlWriter writer, object?[] values, CancellationToken cancellation) => WriteBody(ref writer, values, cancellation, true);
    private void WriteBody(ref HtmlWriter writer, object?[] values, CancellationToken cancellation, bool deferred)
    {
        var active = writer.Context?.Adopting == true;
        if (active) { writer.Write("<!--html-next:"); writer.Write(Prefix); writer.Write("start-->"); }
        foreach (var operation in Body)
            if (deferred) operation.WriteDeferred(ref writer, values, cancellation); else operation.Write(ref writer, values, cancellation);
        if (active) { writer.Write("<!--html-next:"); writer.Write(Prefix); writer.Write("end-->"); }
    }
}

internal sealed record HydrationState(string Name, int Slot, ValueType Type, LocalDeclaration? Seed);

internal sealed record InstanceRecordPlan(string Tag, int Slot, Prop[] Props, HydrationState[] States, string Source, bool ForwardsAttributes)
{
    public InstanceInputs Inputs(object?[] values) => (InstanceInputs)values[Slot]!;

    public object Record(object?[] values, RenderContext context)
    {
        var input = Inputs(values);
        var state = new Dictionary<string, object?>(StringComparer.Ordinal);
        var initialized = new List<string>();
        foreach (var item in States)
        {
            var value = item.Seed?.Read(values) ?? values[item.Slot];
            state.Add(item.Name, ExpressionValue.StoredValue(value, item.Type));
            if (item.Seed is not null && ((DeclarationEvaluation)values[item.Seed.ContextSlot]!).Initialized(item.Seed)) initialized.Add(item.Name);
        }
        var record = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["explicit"] = input.Explicit.ToArray(), ["inputs"] = input.Values,
            ["props"] = Props.Select((prop, index) => (prop.Name, Value: (object?)ExpressionValue.StoredValue(values[index], prop.Type)))
                .ToDictionary(item => item.Name, item => item.Value, StringComparer.Ordinal),
            ["state"] = state
        };
        if (initialized.Count > 0) record.Add("initialized", initialized.ToArray());
        if (ForwardsAttributes)
        {
            var attributes = new Dictionary<string, string?>(StringComparer.Ordinal);
            context.InvocationAttributesFor(values)?.Apply(attributes);
            record.Add("attributes", attributes.Where(attribute => attribute.Value is not null)
                .Select(attribute => new[] { attribute.Key, attribute.Value! }).ToArray());
        }
        return record;
    }

    public void Write(ref HtmlWriter writer, object?[] values, RenderContext context, CancellationToken cancellation)
    {
        var input = Inputs(values);
        if (input.SerializedRoot is null)
        {
            var records = new Dictionary<string, object?>(StringComparer.Ordinal);
            Dictionary<string, PreparedModuleRecord>? prepared = null;
            foreach (var parent in context.RootStyles())
                if (parent.Style.Instance is { } instance)
                {
                    records.Add(instance.Tag, instance.Record(parent.Values, context));
                    if (context.PreparedModule(instance.Inputs(parent.Values)) is { } module) (prepared ??= new(StringComparer.Ordinal)).Add(instance.Tag, module);
                }
            records.Add(Tag, Record(values, context));
            if (context.PreparedModule(input) is { } own) (prepared ??= new(StringComparer.Ordinal)).Add(Tag, own);
            input.SerializedRoot = HydrationRecords.Encode(records, Source, cancellation);
            if (prepared is not null) context.RecordModuleBindings(input, PreparedModuleRecords.Encode(prepared, Source, cancellation));
        }
        writer.Write(" data-html-next-instance=\"");
        HtmlOutput.Escape(ref writer, input.SerializedRoot, true);
        writer.Write('"');
        if (context.SerializedModuleBindings(input) is { } bindings)
        {
            writer.Write(" data-html-next-bindings=\"");
            HtmlOutput.Escape(ref writer, bindings, true);
            writer.Write('"');
        }
    }
}

internal sealed class InstanceInputs
{
    public List<string> Explicit { get; } = [];
    public Dictionary<string, object?> Values { get; } = new(StringComparer.Ordinal);
    public string? SerializedRoot { get; set; }
    public void Add(string name, object? value, bool present, bool provided, string source = "value", bool producer = false)
    {
        if (present && value is not null && !ReferenceEquals(value, ExpressionValue.AbsentStorage)
            && (value is not ExpressionValue expression || !expression.IsNull && !expression.IsAbsent)) Explicit.Add(name);
        Values.Add(name, new Dictionary<string, object?> { ["value"] = value, ["source"] = source, ["present"] = present, ["provided"] = provided, ["producer"] = producer });
    }
}

// The existing browser decoder owns this format. Every container receives its reference index
// before its contents; repeated values share identity, while cycles are rejected like Node output.
internal static class HydrationRecords
{
    public static string Encode(object value, string source, CancellationToken cancellation)
    {
        using var buffer = new MemoryStream();
        using var writer = new Utf8JsonWriter(buffer);
        var references = new Dictionary<object, int>(ReferenceEqualityComparer.Instance);
        var ancestors = new HashSet<object>(ReferenceEqualityComparer.Instance);
        writer.WriteStartArray(); writer.WriteNumberValue(1);
        Write(value);
        writer.WriteEndArray(); writer.Flush();
        return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, checked((int)buffer.Length));

        void Write(object? item)
        {
            cancellation.ThrowIfCancellationRequested();
            ExecutionStack.Check(source);
            writer.WriteStartArray();
            if (ReferenceEquals(item, ExpressionValue.AbsentStorage)) writer.WriteStringValue("absent");
            else if (ReferenceEquals(item, ExpressionValue.InvalidStorage)) writer.WriteStringValue("nonconforming");
            else if (item is ExpressionValue expression)
            {
                if (expression.IsAbsent) writer.WriteStringValue("absent");
                else if (expression.IsInvalid) writer.WriteStringValue("nonconforming");
                else if (expression.Type.Kind is "object" or "list") Container(expression.Data!, expression);
                else if (expression.IsDimension) Scalar(expression.ScalarText());
                else Scalar(expression.Store());
            }
            else if (item is IReadOnlyDictionary<string, object?> or object?[]) Container(item, null);
            else Scalar(item);
            writer.WriteEndArray();
        }

        void Scalar(object? item)
        {
            if (item is sbyte or byte or short or ushort or int or uint or long or ulong or float or decimal)
                item = Convert.ToDouble(item, System.Globalization.CultureInfo.InvariantCulture);
            if (item is double number && number == 0 && double.IsNegative(number)) { writer.WriteStringValue("negative-zero"); return; }
            writer.WriteStringValue("value");
            switch (item)
            {
                case null: writer.WriteNullValue(); break;
                case string text: Text(text); break;
                case bool boolean: writer.WriteBooleanValue(boolean); break;
                case double scalar when double.IsFinite(scalar): writer.WriteNumberValue(scalar); break;
                default: throw Error();
            }
        }

        void Container(object identity, ExpressionValue? expression)
        {
            if (ancestors.Contains(identity)) throw Error();
            if (references.TryGetValue(identity, out var reference)) { writer.WriteStringValue("reference"); writer.WriteNumberValue(reference); return; }
            references.Add(identity, references.Count);
            ancestors.Add(identity);
            var isObject = expression?.Type.Kind == "object" || identity is IReadOnlyDictionary<string, object?>;
            writer.WriteStringValue(isObject ? "object" : "array"); writer.WriteStartArray();
            if (expression is { } aggregate)
            {
                for (var index = 0; index < aggregate.Count; index++)
                {
                    var value = aggregate.ItemUnchecked(index);
                    if (isObject && value.IsAbsent) continue;
                    if (isObject) { writer.WriteStartArray(); Text(aggregate.Type.Fields![index].Name); }
                    Write(value);
                    if (isObject) writer.WriteEndArray();
                }
            }
            else if (identity is IReadOnlyDictionary<string, object?> record)
                foreach (var (name, value) in record) { writer.WriteStartArray(); Text(name); Write(value); writer.WriteEndArray(); }
            else foreach (var value in (object?[])identity) Write(value);
            writer.WriteEndArray(); ancestors.Remove(identity);
        }

        void Text(string text)
        {
            for (var index = 0; index < text.Length; index++)
            {
                if (!char.IsSurrogate(text[index])) continue;
                if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1])) { index++; continue; }
                // Utf8JsonWriter replaces lone surrogates; JSON Unicode escapes preserve their JavaScript code units.
                var escaped = new StringBuilder("\"");
                foreach (var character in text) escaped.Append("\\u").Append(((int)character).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                escaped.Append('"');
                writer.WriteRawValue(escaped.ToString(), skipInputValidation: true);
                return;
            }
            writer.WriteStringValue(text);
        }

        HtmlNextException Error() => new("HNCS008", "Rendered component values must be finite serializable data without cycles or opaque values.", source);
    }
}
