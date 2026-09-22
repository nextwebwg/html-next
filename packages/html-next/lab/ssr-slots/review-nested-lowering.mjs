import { chromium } from "playwright";
import { build } from "esbuild";
const runtime = (await build({ entryPoints: ["/Users/matthew/git/oss/nextwebwg/html-next/packages/html-next/src/runtime.ts"], bundle: true, format: "iife", globalName: "HtmlRuntime", write: false, platform: "browser", logLevel: "error" })).outputFiles[0].text;
const b = await chromium.launch(); const p = await b.newPage();
await p.setContent(`<!doctype html><body><template component="x-card" status="early" summary="t."><article class="card"><slot></slot></article></template>
<template component="x-wrap" status="early" summary="t."><section><x-card><slot></slot></x-card></section></template>
<template component="x-deleg" status="early" summary="t."><x-card><slot></slot></x-card></template>
<x-wrap>A</x-wrap><x-deleg>B</x-deleg>`);
await p.addScriptTag({ content: runtime });
console.log(await p.evaluate(async () => { HtmlRuntime.lowerDocument(); await new Promise(r=>setTimeout(r,200)); HtmlRuntime.lowerDocument(); await new Promise(r=>setTimeout(r,200)); return document.body.innerHTML.replace(/<template[\s\S]*?<\/template>/g,""); }));
await b.close();
