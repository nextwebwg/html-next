import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { convertComponents } from "../src/index.js";
import assert from "node:assert/strict";
import { it } from "vitest";
const run = promisify(execFile);
const require = createRequire(new URL('../../html-next-unplugin/package.json', import.meta.url));
const checker = require.resolve('svelte-check/bin/svelte-check');
it("checks an independently installed Svelte library with native consumers", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'html-next-installed-svelte-types-'));
  try {
    const source = join(directory, "source");
    const pkg = join(directory, "package");
    const consumer = join(directory, "consumer");
    await Promise.all([mkdir(source), mkdir(pkg), mkdir(consumer)]);
    await writeFile(join(source, 'types.html'), `<template component="x-typed" status="early" summary="Typed consumer." controller="./types.js"><defs><prop name="kind" type="keyword" values="text, number" default="text">Kind.</prop><prop name="value">Value.<type from="kind"><option value="text" type="string"></option><option value="number" type="number"></option></type></prop><event name="change" type="boolean">Change.</event><method name="ping" returns="promise(number)"></method></defs><button><slot name="row" from:item="'Ada'"></slot></button></template>
      <template component="x-plain" status="early" summary="Unscoped slots."><section><slot name="title"></slot><slot></slot></section></template>
      <template component="x-dynamic" status="early" summary="Dynamic scoped slots."><defs><prop name="outlet" type="string" default="row">Outlet.</prop></defs><section><slot name="fixed" from:index="2"></slot><slot from:name="outlet" from:item="'Ada'"></slot></section></template>`);
    await writeFile(join(source, 'types.js'), 'export default function connect(host) {} export async function ping(host) { return 1; }');
    const manifest = await convertComponents({ target: 'svelte', mode: 'library', root: source, outDirectory: pkg, entries: ['types.html'] });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@example/svelte-types-probe', version: '0.0.0', private: true, license: 'MIT', type: 'module', files: ['svelte'], exports: { '.': './svelte/index.ts', './XTyped': './svelte/XTyped.svelte' }, dependencies: manifest.package.dependencies, peerDependencies: manifest.package.peerDependencies }));
    const packed = await run('npm', ['pack', '--json', '--pack-destination', directory], { cwd: pkg });
    const archive = join(directory, JSON.parse(packed.stdout)[0].filename);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name:'svelte-types-consumer', private:true, type:'module' }));
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', archive], { cwd: consumer });
    await symlink(fileURLToPath(new URL('../node_modules/svelte', import.meta.url)), join(consumer, 'node_modules', 'svelte'), 'dir');
    const cases: readonly (readonly [string, string])[] = [
      ['generic-positive', '<script lang="ts">import { XTyped } from "@example/svelte-types-probe";</script><XTyped kind="number" value={2} /><XTyped kind="text" value="Ready" />'],
      ['generic-negative', '<script lang="ts">import { XTyped } from "@example/svelte-types-probe";</script><XTyped kind="number" value="Ready" />'],
      ['native-event-positive', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped";</script><XTyped onclick={(event) => { const target: Element = event.currentTarget; }} />'],
      ['native-event-negative', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped";</script><XTyped onclick={(event: KeyboardEvent) => {}} />'],
      ['declared-event-positive', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped";</script><XTyped onchange={(event) => { const detail: boolean = event.detail; }} />'],
      ['declared-event-negative', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped";</script><XTyped onchange={(event: CustomEvent<string>) => {}} />'],
      ['method-positive', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped"; let instance: ReturnType<typeof XTyped>; function ping() { const result: Promise<number> = instance.ping(); }</script><XTyped bind:this={instance} />'],
      ['method-negative', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped"; let instance: ReturnType<typeof XTyped>; function ping() { const result: Promise<string> = instance.ping(); }</script><XTyped bind:this={instance} />'],
      ['slot-positive', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped";</script>{#snippet row(props: {item: unknown})}{props.item}{/snippet}<XTyped slots={{row}} />'],
      ['default-and-named-slot-positive', '<script lang="ts">import { XPlain } from "@example/svelte-types-probe";</script>{#snippet title()}Title{/snippet}<XPlain slots={{title}}>Default</XPlain>'],
      ['dynamic-slot-positive', '<script lang="ts">import { XDynamic } from "@example/svelte-types-probe";</script>{#snippet row(props: {item: unknown})}{props.item}{/snippet}{#snippet fixed(props: {index: unknown})}{props.index}{/snippet}<XDynamic slots={{row, fixed}} />'],
      ['dynamic-slot-negative', '<script lang="ts">import { XDynamic } from "@example/svelte-types-probe";</script>{#snippet row(props: {wrong: unknown})}{props.wrong}{/snippet}<XDynamic slots={{row}} />'],
      ['declared-event-capture-positive', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped";</script><XTyped onchangecapture={(event) => { const detail: boolean = event.detail; }} />'],
      ['slot-negative', '<script lang="ts">import XTyped from "@example/svelte-types-probe/XTyped";</script>{#snippet row(props: {wrong: unknown})}{props.wrong}{/snippet}<XTyped slots={{row}} />'],
    ];
    const expectedErrors: Record<string, RegExp> = {
      "generic-negative": /string.*number/,
      "native-event-negative": /KeyboardEvent|MouseEvent/,
      "declared-event-negative": /string.*boolean|CustomEvent<string>/,
      "method-negative": /Promise<number>.*Promise<string>/,
      "slot-negative": /wrong|item/,
      "dynamic-slot-negative": /wrong|item|index/,
    };
    const config = join(consumer, "tsconfig.json");
    await writeFile(config, JSON.stringify({ compilerOptions: {
      strict: true, skipLibCheck: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", allowJs: true,
    }, files: ["Consumer.svelte"] }));
    const check = () => run(process.execPath, [checker, "--tsconfig", config, "--output", "machine"], { cwd: consumer });
    for (const [name, contents] of cases) {
      await writeFile(join(consumer, 'Consumer.svelte'), contents);
      const expected = expectedErrors[name];
      if (expected === undefined) {
        try { await check(); }
        catch (error) { assert.fail(`${name}: ${(error as { stdout: string }).stdout}`); }
      } else {
        await assert.rejects(check(), (error: unknown) => {
          assert.match((error as { stdout: string }).stdout, expected, name);
          return true;
        }, `${name} must be rejected by the installed consumer`);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
