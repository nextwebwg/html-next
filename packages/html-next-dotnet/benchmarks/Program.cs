using System.Globalization;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Exporters;
using BenchmarkDotNet.Running;
using Fluid;
using HtmlNext;

if (args.Contains("--validate", StringComparer.Ordinal) || args.Contains("--allocations", StringComparer.Ordinal) || args.Contains("--phases", StringComparer.Ordinal))
{
    foreach (var name in new[] { "card", "list-10", "list-100", "list-1000", "cart-100" })
    {
        var benchmark = new TemplateBenchmarks { Case = name };
        benchmark.Setup();
        if (args.Contains("--allocations", StringComparer.Ordinal)) benchmark.ProfileAllocations();
        if (args.Contains("--phases", StringComparer.Ordinal)) benchmark.ProfilePhases();
    }
    return;
}
var summary = BenchmarkRunner.Run<TemplateBenchmarks>(args: args);
if (summary.Reports.Any(report => !report.Success)) Environment.ExitCode = 1;

[MemoryDiagnoser]
[ShortRunJob]
[JsonExporterAttribute.Full]
public class TemplateBenchmarks
{
    [Params("card", "list-10", "list-100", "list-1000", "cart-100")]
    public string Case { get; set; } = "card";
    private CompiledTemplate template = null!;
    private IFluidTemplate liquid = null!;
    private object inputs = null!;
    private TemplateOptions options = null!;

    [GlobalSetup]
    public void Setup()
    {
        var cases = JsonSerializer.Deserialize<CaseDefinition[]>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "cases.json")),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        var subject = cases.Single(item => item.Name == Case);
        var start = Stopwatch.GetTimestamp();
        template = HtmlNextCompiler.Compile(subject.Html, subject.Name + ".html");
        var compileOnceNs = Stopwatch.GetElapsedTime(start).TotalNanoseconds;
        start = Stopwatch.GetTimestamp();
        liquid = new FluidParser().Parse(subject.Liquid);
        var liquidParseOnceNs = Stopwatch.GetElapsedTime(start).TotalNanoseconds;
        options = new TemplateOptions();
        options.MemberAccessStrategy.Register<CardInput>();
        options.MemberAccessStrategy.Register<ListInput>();
        options.MemberAccessStrategy.Register<Product>();
        options.MemberAccessStrategy.Register<CartInput>();
        options.MemberAccessStrategy.Register<CartProduct>();
        inputs = subject.Rows == 0 ? new CardInput("A & B <C>", true)
            : subject.Computed ? new CartInput(Enumerable.Range(0, subject.Rows).Select(index => new CartProduct("Item " + index + " & <value>", index + 0.5, index % 2 * 2 + 1)).ToArray())
            : new ListInput(Enumerable.Range(0, subject.Rows).Select(index => new Product("Item " + index + " & <value>", index + 0.5)).ToArray());
        var expected = subject.Rows == 0 ? "<article title=\"A &amp; B &lt;C&gt;\"><h2>A &amp; B &lt;C&gt;</h2></article>"
            : subject.Computed ? "<ul>" + string.Concat(Enumerable.Range(0, subject.Rows).Select(index => "<li>Item " + index + " &amp; &lt;value&gt;: " + ((index + 0.5) * (index % 2 * 2 + 1)).ToString(CultureInfo.InvariantCulture) + "</li>")) + "</ul>"
            : "<ul>" + string.Concat(Enumerable.Range(0, subject.Rows).Select(index => "<li><span>Item " + index + " &amp; &lt;value&gt;</span><b>" + (index + 0.5).ToString(CultureInfo.InvariantCulture) + "</b></li>")) + "</ul>";
        var native = HtmlNext();
        var fluid = Liquid();
        if (native != expected || fluid != expected)
        {
            var actual = native != expected ? native : fluid;
            var at = 0;
            while (at < Math.Min(actual.Length, expected.Length) && actual[at] == expected[at]) at++;
            throw new InvalidOperationException($"Full output validation failed for {Case} ({(native != expected ? "native" : "Fluid")}, at {at}, lengths {actual.Length}/{expected.Length}): {actual.Substring(at, Math.Min(60, actual.Length - at))} / {expected.Substring(at, Math.Min(60, expected.Length - at))}");
        }
        var receipt = new
        {
            name = Case, rows = subject.Rows, bytes = Encoding.UTF8.GetByteCount(expected),
            compileOnceNs, liquidParseOnceNs,
            outputSha256 = Hash(expected), templateSha256 = Hash(subject.Html), liquidSha256 = Hash(subject.Liquid),
            modelSha256 = Hash(JsonSerializer.Serialize(inputs, inputs.GetType(), new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping })),
            fluidVersion = typeof(FluidParser).Assembly.GetName().Version?.ToString(),
            angleSharpVersion = typeof(AngleSharp.Html.Parser.HtmlParser).Assembly.GetName().Version?.ToString(),
            nativeAssemblySha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(typeof(HtmlNextCompiler).Assembly.Location)))
        };
        Console.WriteLine("VALIDATED " + JsonSerializer.Serialize(receipt));
    }

    [Benchmark]
    public string HtmlNext() => template.Render(inputs);

    [Benchmark(Baseline = true)]
    public string Liquid() => liquid.Render(new TemplateContext(inputs, options) { CultureInfo = CultureInfo.InvariantCulture }, HtmlEncoder.Default);

    public void ProfileAllocations()
    {
        const int repetitions = 200;
        var writer = new AllocationWriter();
        for (var index = 0; index < 2000; index++) { HtmlNext(); Liquid(); }
        static double Measure(Action action)
        {
            var start = GC.GetAllocatedBytesForCurrentThread();
            for (var index = 0; index < repetitions; index++) action();
            return (GC.GetAllocatedBytesForCurrentThread() - start) / (double)repetitions;
        }
        var nativeTotal = Measure(() => GC.KeepAlive(HtmlNext()));
        var fluidTotal = Measure(() => GC.KeepAlive(Liquid()));
        long binding = 0;
        var nativeWriter = Measure(() =>
        {
            writer.Reset();
            template.Write(writer, inputs);
            binding += writer.BeforeFirstWrite;
        });
        var fluidWriter = Measure(() => liquid.RenderAsync(TextWriter.Null, new TemplateContext(inputs, options) { CultureInfo = CultureInfo.InvariantCulture }, HtmlEncoder.Default).GetAwaiter().GetResult());
        Console.WriteLine("ALLOCATIONS " + JsonSerializer.Serialize(new
        {
            name = Case, repetitions, nativeTotalBytes = nativeTotal, fluidTotalBytes = fluidTotal,
            nativeBindingBytes = binding / (double)repetitions, nativeWriterBytes = nativeWriter,
            nativeOutputBufferAndStringBytes = nativeTotal - nativeWriter, fluidWriterBytes = fluidWriter,
            fluidOutputBufferAndStringBytes = fluidTotal - fluidWriter
        }));
    }

    public void ProfilePhases()
    {
        const int repetitions = 10000;
        for (var i = 0; i < 2000; i++) HtmlNext();
        var writer = new AllocationWriter();
        var start = Stopwatch.GetTimestamp();
        for (var i = 0; i < repetitions; i++) HtmlNext();
        var render = Stopwatch.GetElapsedTime(start).TotalNanoseconds / repetitions;
        double bind = 0;
        start = Stopwatch.GetTimestamp();
        for (var i = 0; i < repetitions; i++) { writer.Reset(); template.Write(writer, inputs); bind += writer.BeforeFirstWriteNs; }
        Console.WriteLine("PHASES " + JsonSerializer.Serialize(new { name = Case, repetitions, renderNs = render,
            writerNs = Stopwatch.GetElapsedTime(start).TotalNanoseconds / repetitions, bindingNs = bind / repetitions,
            limitation = "Locating measurement, not a throughput verdict. First-write timestamp includes observation overhead; no confidence interval." }));
    }

    private sealed class AllocationWriter : TextWriter
    {
        private long start;
        private long timestamp;
        private bool first;
        public long BeforeFirstWrite { get; private set; }
        public double BeforeFirstWriteNs { get; private set; }
        public override Encoding Encoding => Encoding.UTF8;
        public void Reset() { first = true; BeforeFirstWrite = 0; BeforeFirstWriteNs = 0; start = GC.GetAllocatedBytesForCurrentThread(); timestamp = Stopwatch.GetTimestamp(); }
        private void Observe()
        {
            if (!first) return;
            BeforeFirstWrite = GC.GetAllocatedBytesForCurrentThread() - start;
            BeforeFirstWriteNs = Stopwatch.GetElapsedTime(timestamp).TotalNanoseconds;
            first = false;
        }
        public override void Write(string? value) => Observe();
        public override void Write(char value) => Observe();
        public override void Write(ReadOnlySpan<char> value) => Observe();
    }

    private static string Hash(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    private sealed record CaseDefinition(string Name, int Rows, string Html, string Liquid, bool Computed = false);
    public sealed record CardInput(string title, bool visible);
    public sealed record Product(string label, double price);
    public sealed record ListInput(Product[] products);
    public sealed record CartProduct(string label, double price, int quantity);
    public sealed record CartInput(CartProduct[] products);
}
