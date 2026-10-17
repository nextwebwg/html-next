# componentRegistry support

This support note says which [`componentRegistry`](https://nextwebwg.org/declarative-components/javascript#component-registry)
behaviors each HTML Next delivery mode implements. The proposal defines the behavior. This note is
tooling documentation for this repository's packages.

Every delivery mode on a page shares one registry for each document. The registry's state lives on
the document record that every HTML Next bundle already shares, so a bundle can create and update a
component that another bundle defined ([one registry for each document](https://nextwebwg.org/declarative-components/javascript#component-registry-why)).
`@nextwebwg/html-next`, `/runtime`, `/live`, `/browser` and `/generated-runtime` export the same
`componentRegistry`. Importing it reads no document.

## Live runtime

The live runtime is `@nextwebwg/html-next/browser`, `/live`, and `/runtime` with registered definitions.

| Behavior | Support |
| --- | --- |
| [Registration](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Supported. The runtime registers every definition it discovers in the document, loads through `<link rel="component">`, or is given through `registerComponentDefinitions`, `installComponentGraph` or `attachComponent`. |
| [`define(carrier)`](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Supported where the live delivery's parser is installed: `/browser`, and `/live`'s `lowerDocument` and `observeDocument`. Defining lowers the tag's invocations already in the document. `/runtime` alone has no parser, so `define` throws a `NotSupportedError` there. A carrier whose `<style>` uses [`@import`](https://nextwebwg.org/declarative-components/styling#shared-css) is not supported, though the proposal allows it: `define` compiles styles synchronously and fails with `HY004`. A discovered inline definition with `@import` is supported. |
| [`get`, `whenDefined`](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Supported. |
| [`upgrade(root)`](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Supported. |
| [`create(tag, init)`](https://nextwebwg.org/declarative-components/javascript#component-registry-create) | Supported. In an observed document (`/browser`, or `observeDocument`), inserting the root connects the instance, and its controller runs when it first connects, for linked and inline definitions alike. A document lowered only with `lowerDocument` connects the instance when it is created, as explicit lowering connects every instance it lowers. |
| [`update(element, props)`](https://nextwebwg.org/declarative-components/javascript#component-registry-update) | Supported for created, lowered and hydrated instances, and for roots a framework attaches with `attachComponent`. |

## Compiled Vanilla DOM

Compiled Vanilla DOM is the output of `generateComponent`, `html-next build` and the native Vite plugin.

| Behavior | Support |
| --- | --- |
| [Registration](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Supported when the module is evaluated: the module ends with `defineComponent(tag, createX, props)`. A compiled registration replaces an earlier compiled one for the same tag, as when hot module replacement evaluates a module again. A live runtime registration for the tag stays in place. |
| Lowering existing markup on registration | Not supported. A compiled module renders through its factory and lowers no authored `<x-tag>` already in the document. Load the live runtime to lower authored markup. |
| [`define(carrier)`](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Not supported. Compiled output has no parser, so `define` throws a `NotSupportedError` unless the live runtime is on the page. |
| [`upgrade(root)`](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Not supported without the live runtime. `upgrade` does nothing on a page that has only compiled modules. |
| [`get`, `whenDefined`](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Supported. |
| [`create(tag, init)`](https://nextwebwg.org/declarative-components/javascript#component-registry-create) | Supported. Each content element goes to the slot its `slot` attribute names. Every other node goes to the default slot. Inserting the root connects it. A [`<template slot>`](https://nextwebwg.org/declarative-components/components#content-that-renders-on-demand) given as content renders only while its slot renders, as an authored one does. When the live runtime is on the page, the live runtime renders it, with its bindings reading the slot's props. Compiled output alone has no parser: it renders a template with no HTML Next syntax as a copy of its content, and throws `HR007` for one with bindings. |
| [`update(element, props)`](https://nextwebwg.org/declarative-components/javascript#component-registry-update) | Supported. |
| [Types](https://nextwebwg.org/declarative-components/javascript#component-registry-types) | Supported. Each generated `.d.ts` adds its tag to the global `ComponentTagMap`. |

A compiled module registers only if the bundle keeps it:

- **Native Vite plugin:** the plugin keeps every component module, so importing a component's module defines it. The exception is a component from an installed package whose `package.json` declares `sideEffects` as `false` or a list. The build drops such a module when nothing imports its factory, and drops its registration with it.
- **Packages from `assembleComponentPackage`:** these packages declare `sideEffects` as a list. In any bundler, a component from one registers only when code imports its factory.

## Vue, React and Svelte targets

| Behavior | Support |
| --- | --- |
| [Registration](https://nextwebwg.org/declarative-components/javascript#component-registry-define) | Not supported. Converted framework components render through their framework and register nothing. To create a component inside a framework application, also load its compiled Vanilla module or the live runtime. `create` then makes an HTML Next instance, as the proposal [specifies](https://nextwebwg.org/declarative-components/javascript#component-registry-create). |
| [`update(element, props)`](https://nextwebwg.org/declarative-components/javascript#component-registry-update) | Not supported on a converted framework component's root, which has no HTML Next instance: `update` throws a `TypeError`. Set its props through the framework. |

## Server

`create` and `update` run in the browser only. `renderComponents` takes its definitions in each call
and reads no registry, so concurrent requests share nothing. Server code imports `componentRegistry`
safely.
