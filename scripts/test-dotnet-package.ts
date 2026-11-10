import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../packages/html-next-dotnet/src/HtmlNext/HtmlNext.csproj", import.meta.url));
const configuration = await readFile(project, "utf8");
const id = /<PackageId>([^<]+)<\/PackageId>/.exec(configuration)![1]!;
const version = /<Version>([^<]+)<\/Version>/.exec(configuration)![1]!;
const directory = await mkdtemp(join(tmpdir(), "html-next-nuget-consumer-"));
try {
  const feed = join(directory, "feed");
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  await execute("dotnet", ["pack", project, "-c", "Release", "--output", feed, "--nologo"]);
  await writeFile(join(consumer, "Consumer.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup>
    <ItemGroup><PackageReference Include="${id}" Version="${version}" /></ItemGroup>
  </Project>`);
  await writeFile(join(consumer, "Program.cs"), `using HtmlNext;
    var template = HtmlNextCompiler.Compile("""
      <template component="x-card"><defs><prop name="title" type="string" required>Title.</prop></defs><article><h2>{$title}</h2></article></template>
      """);
    var html = template.Render(new { title = "A & B <C>" });
    if (html != "<article><h2>A &amp; B &lt;C&gt;</h2></article>") throw new Exception(html);
    using var writer = new StringWriter();
    template.Write(writer, new { title = "A & B <C>" });
    if (writer.ToString() != html || template.Validate(new { title = "Valid" }).Count != 0) throw new Exception("Package consumer failed");
    Console.WriteLine("NuGet consumer passed");
  `);
  await execute("dotnet", ["restore", "--source", feed, "--source", "https://api.nuget.org/v3/index.json", "--packages", join(directory, "packages"), "--nologo"], { cwd: consumer });
  const result = await execute("dotnet", ["run", "-c", "Release", "--no-restore", "--nologo"], { cwd: consumer });
  assert.match(result.stdout, /NuGet consumer passed/);
  console.log(`${id} ${version}: packed, restored in an isolated consumer, and rendered escaped HTML through Render and Write.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
