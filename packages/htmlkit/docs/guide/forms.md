---
title: Forms
order: 4
blurb: actions · validation errors · in place · pending UI
eyebrow: HTMLKit
---

# Forms

A form on a page posts to the page, and an action in the page's loader file answers it. The form is
an ordinary `<form method="post">`, so it works before any script loads and without JavaScript; once
the page has loaded, HTMLKit submits it in place.

```html
<!-- app/pages/todos.html -->
<template component="todos-page">
  <defs>
    <prop name="todos" type="list(string)" required>Todos</prop>
    <meta name="hk:render" content="server">
    <title>Todos</title>
  </defs>

  <section>
    <form method="post">
      <label>Title <input name="title" required></label>
      <button>Add</button>
    </form>
    <ul><li $each="todo of $todos">{$todo}</li></ul>
  </section>
</template>
```

```ts
// app/pages/todos.server.ts
import type { LoadContext, PageAction } from '@nextwebwg/htmlkit';
import { db } from '@/lib/db.ts';

export async function load({ cookies }: LoadContext) {
  return { props: { todos: await db.todos.list(cookies.get('session')) } };
}

export const actions: Record<string, PageAction> = {
  async default({ request, cookies }) {
    const form = await request.formData();
    await db.todos.add(cookies.get('session'), String(form.get('title')));
  },
};
```

Submitting the form runs `default`, then the browser loads `/todos/` again with the new todo. That is
POST/redirect/GET: reloading or going back never sends the form twice.

## What an action receives and returns

An action receives the same context as the [page's loader](/htmlkit/loaders#rendering-on-each-request):
`request`, `url`, `params`, `cookies`, and `response`, plus `redirect()` and `notFound()`. Read the
form with `await request.formData()`, which reads every encoding a form sends. The action runs before
every loader of the page, layouts' included, so the page renders with what it changed.

| The action | The answer |
| --- | --- |
| Returns nothing | 303 to the page's own URL, without the action's name |
| Calls `redirect('/todos/42/')` | 303 to that URL, or the status you pass |
| Returns an object, such as `{ errors, values }` | The page, rendered with those props over its loader's |
| Sets `response.status = 422` and returns an object | The same page, with that status |
| Sets `response.headers` | Those headers, on the redirect or the page |
| Calls `notFound()` | The not-found page, with 404 |

A page that renders on each request has actions; a page that prerenders has no request to answer,
so a build that finds `actions` on one fails, naming the page and its loader file. A layout's loader
file has no actions.

## Showing validation errors

Return the errors and the submitted values as props the page declares, and the page renders them:

```html
<template component="todos-page">
  <defs>
    <prop name="todos" type="list(string)" required>Todos</prop>
    <prop name="errors" type="object({ title?: string })" default="{}">Field errors</prop>
    <prop name="values" type="object({ title?: string })" default="{}">Submitted values</prop>
    <meta name="hk:render" content="server">
    <title>Todos</title>
  </defs>

  <section>
    <form method="post">
      <label>Title
        <input name="title" from:value="$values.title" from:autofocus="$errors.title"
          from:aria-invalid="$errors.title ? 'true' : 'false'" aria-describedby="title-error">
      </label>
      <p id="title-error" $if="$errors.title">{$errors.title}</p>
      <button>Add</button>
    </form>
    <ul><li $each="todo of $todos">{$todo}</li></ul>
  </section>
</template>
```

```ts
export const actions: Record<string, PageAction> = {
  async default({ request, response, cookies }) {
    const title = String((await request.formData()).get('title') ?? '').trim();
    if (title.length < 3) {
      response.status = 422;
      return { errors: { title: 'Use at least 3 characters.' }, values: { title } };
    }
    await db.todos.add(cookies.get('session'), title);
  },
};
```

The keys an action returns are the page's props, so a key the page doesn't declare is an error that
names the page. Give the first invalid field `autofocus`, as above: a page load focuses it, and so
does a submission in place. Constraint attributes such as `required` and `minlength` still check
the form in the browser first; the action checks again, since a request can come from anywhere.

## Several actions on a page

Name an action with `?/name` in the form's `action`, or in a button's `formaction`, so one form can
post to several:

```html
<form method="post" action="?/create">
  <input name="title">
  <button>Add</button>
  <button formaction="?/clear" formnovalidate>Clear all</button>
</form>
```

```ts
export const actions: Record<string, PageAction> = {
  async create({ request }) { /* … */ },
  async clear({ cookies }) { await db.todos.clear(cookies.get('session')); },
};
```

The name is part of the URL the form posts to, so it needs no hidden field, keeps the form's own
fields as they are, and works with every button's `formaction`. A form without `?/name` runs
`default`. A name the page doesn't export answers 404; a page without `actions` answers a POST
with 405.

## Submitting in place

Once the page has loaded, a form that posts to a page of the site submits with `fetch`, and
HTMLKit swaps in the answer the way [client navigation](/htmlkit/client-navigation) swaps in a page:

| Part of the submission | In place |
| --- | --- |
| The request | The same `POST`, with the form's fields, encoding and submitter's `formaction` |
| An action that redirects | The redirect's page replaces the submission in history, as after a document's POST/redirect/GET |
| An action that returns props | The page renders at the action's URL, as a document POST would show it |
| A layout both pages use | Stays, with its state |
| Keyboard focus | The first `autofocus` field, else the start of the page, as after a page load |
| Screen readers | Hear the page's title once it renders |

Without JavaScript, or in a browser without the Navigation API, the form submits as a document
does, with the same result. Put `data-hk-reload` on a form, or an element around it, to always
submit it as a document. A form that posts to an [endpoint](/htmlkit/server), another site, or
another window submits as a document too.

While a form submits in place, it has `data-hk-submitting` and `aria-busy="true"`, and `<html>`
has `data-hk-navigating`. See [showing that a page is loading](/htmlkit/client-navigation#showing-that-a-page-is-loading).

## Cross-site submissions

A page answers a `POST` only from its own site. A browser sends `Sec-Fetch-Site` with each request,
or `Origin` in older browsers, and a form on another site that posts to yours gets 403 before any
action runs. A request without either header, such as one from `curl`, is no browser's form and goes
through. [Endpoints](/htmlkit/server) receive their requests as sent; check
`request.headers.get('sec-fetch-site')` in one that a form on your pages posts to.

Next: [Navigation](/htmlkit/navigation).
