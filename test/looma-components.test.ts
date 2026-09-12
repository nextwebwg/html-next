import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { chromium } from "playwright";

const enabled = process.env.HTMLNEXT_LOOMA_TEST === "1";
const components = new URL("../examples/looma/components/", import.meta.url);
const runtime = new URL("../src/runtime.ts", import.meta.url);

describe("reviewed Looma HTML Next components", { skip: !enabled }, () => {
  let directory = "";
  let bundle = "";
  let controllerBundle = "";
  let definitions = "";
  let compatibilityStyles = "";

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "html-next-looma-components-"));
    bundle = join(directory, "runtime.js");
    await build({
      entryPoints: [runtime.pathname], bundle: true, format: "iife", globalName: "HtmlRuntime",
      outfile: bundle, platform: "browser", target: ["es2022"],
    });
    controllerBundle = join(directory, "controllers.js");
    const controllerTags = [
      "ui-checkbox", "ui-input", "ui-textarea", "ui-select", "ui-radio", "ui-radio-group", "ui-switch",
      "ui-avatar", "ui-avatar-group", "ui-disclosure", "ui-tabs",
      "ui-affordance-scope", "ui-dialog", "ui-popover", "ui-toast-region", "ui-tooltip",
      "ui-menu", "ui-context-menu",
      "ui-editable", "ui-tree", "ui-tree-item",
      "ui-combobox", "ui-multi-combobox",
    ];
    await build({
      stdin: {
        contents: controllerTags.map((tag, index) =>
          `import * as module${index} from ${JSON.stringify(new URL(`${tag}.js`, components).pathname)};`,
        ).join("\n") + `\nglobalThis.LoomaModules = {${controllerTags.map((tag, index) =>
          `${JSON.stringify(tag)}: module${index}`,
        ).join(",")}};\nglobalThis.LoomaControllers = Object.fromEntries(Object.entries(globalThis.LoomaModules).map(([tag, module]) => [tag, module.default]));`,
        resolveDir: components.pathname,
      },
      bundle: true, format: "iife", outfile: controllerBundle, platform: "browser", target: ["es2022"],
    });
    definitions = (await Promise.all([
      "ui-button", "ui-icon-button", "ui-callout", "ui-chip", "ui-badge",
      "ui-search-shell", "ui-search-result-row", "ui-top-bar", "ui-form-field",
      "ui-menu-item",
      ...controllerTags,
    ].map((tag) => readFile(new URL(`${tag}.html`, components), "utf8")))).join("\n");
    compatibilityStyles = await readFile(new URL("../examples/looma/package-assets/styles.css", import.meta.url), "utf8");
  });

  it("preserves native form controls and controlled or default state", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(definitions + `
        <ui-input id="input" value="locked@example.com" invalid><input id="native-input" type="email" required></ui-input>
        <ui-textarea id="textarea" default-value="draft" rows="7"><textarea id="native-textarea"></textarea></ui-textarea>
        <ui-select id="select" default-value="b" required><select id="native-select"><option value="a">A</option><option value="b">B</option></select></ui-select>
        <ui-checkbox id="checkbox" default-checked required><input id="native-checkbox" type="checkbox"></ui-checkbox>
        <ui-radio id="radio" default-checked value="solo"><input id="native-radio" type="radio"></ui-radio>
        <ui-radio-group id="group" name="choice" value="a" orientation="horizontal">
          <ui-radio id="radio-a" value="a"><input id="native-radio-a" type="radio"></ui-radio>
          <ui-radio id="radio-b" value="b"><input id="native-radio-b" type="radio"></ui-radio>
        </ui-radio-group>
        <ui-switch id="switch" default-checked>Enabled</ui-switch>
      `);
      await page.addScriptTag({ path: bundle });
      await page.addScriptTag({ path: controllerBundle });
      const result = await page.evaluate(`(async () => {
        const original = ['native-input','native-textarea','native-select','native-checkbox','native-radio','native-radio-a','native-radio-b']
          .map(id => document.getElementById(id));
        window.HtmlRuntime.observeDocument(document, { onConnect(root, definition) {
          const controller = window.LoomaControllers[definition.contract.tag];
          if (controller == null) return;
          window.HtmlRuntime.setControllerModule(root, Promise.resolve(window.LoomaModules[definition.contract.tag]));
          return controller(window.HtmlRuntime.getComponentHost(root));
        }});
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
        const inputRoot = document.getElementById('input');
        const input = document.getElementById('native-input');
        const textareaRoot = document.getElementById('textarea');
        const textarea = document.getElementById('native-textarea');
        const select = document.getElementById('native-select');
        const checkboxRoot = document.getElementById('checkbox');
        const checkbox = document.getElementById('native-checkbox');
        const group = document.getElementById('group');
        const radioB = document.getElementById('native-radio-b');
        const switchRoot = document.getElementById('switch');
        const switchInput = switchRoot.querySelector('input');
        const details = [];
        for (const root of [inputRoot, textareaRoot, checkboxRoot, group, switchRoot]) {
          for (const event of ['input','change','select']) root.addEventListener(event, e => {
            if (e.detail != null) details.push([root.id, event, e.detail]);
          });
        }
        input.value = 'edited'; input.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.value = 'notes'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
        select.value = 'a'; select.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        radioB.checked = true; radioB.dispatchEvent(new Event('change', { bubbles: true }));
        switchRoot.click();
        await Promise.resolve(); await Promise.resolve();
        return {
          same: original.every(node => node === document.getElementById(node.id)),
          input: { value: input.value, invalid: inputRoot.hasAttribute('data-invalid'), aria: input.getAttribute('aria-invalid'), typeMismatch: input.validity.typeMismatch },
          textarea: { value: textarea.value, rows: textarea.rows },
          select: { value: select.value, required: select.required },
          checkbox: { checked: checkbox.checked, required: checkbox.required, aria: checkboxRoot.getAttribute('aria-checked') },
          radio: { checked: document.getElementById('native-radio').checked, value: document.getElementById('native-radio').value },
          group: { value: group.value, a: document.getElementById('native-radio-a').checked, b: radioB.checked, bName: radioB.name },
          switch: { checked: switchInput.checked, aria: switchRoot.getAttribute('aria-checked') },
          details,
        };
      })()`) as {
        same: boolean;
        input: unknown;
        textarea: unknown;
        select: unknown;
        checkbox: unknown;
        radio: unknown;
        group: unknown;
        switch: unknown;
        details: Array<[string, string, { value?: string; checked?: boolean }]>;
      };
      assert.equal(result.same, true);
      assert.deepEqual(result.input, { value: "locked@example.com", invalid: true, aria: "true", typeMismatch: false });
      assert.deepEqual(result.textarea, { value: "notes", rows: 7 });
      assert.deepEqual(result.select, { value: "a", required: true });
      assert.deepEqual(result.checkbox, { checked: false, required: true, aria: "false" });
      assert.deepEqual(result.radio, { checked: true, value: "solo" });
      assert.deepEqual(result.group, { value: "a", a: false, b: true, bName: "choice" });
      assert.deepEqual(result.switch, { checked: false, aria: "false" });
      assert.ok(result.details.some(([id, event, detail]) => id === "textarea" && event === "input" && detail.value === "notes"));
      assert.ok(result.details.some(([id, event, detail]) => id === "checkbox" && event === "change" && detail.checked === false));
      assert.ok(result.details.some(([id, event, detail]) => id === "group" && event === "select" && detail.value === "b"));
    } finally {
      await browser.close();
    }
  });

  it("implements avatar fallback, disclosure, tabs, and dynamic group behavior", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(definitions + `
        <ui-avatar id="avatar" name="Matthew Dean"></ui-avatar>
        <ui-avatar-group id="avatars" max="2" label="Reviewers"><span id="person-a">A</span><span id="person-b">B</span><span id="person-c">C</span></ui-avatar-group>
        <ui-menu-item id="menu-item" value="save">Save</ui-menu-item>
        <ui-disclosure id="disclosure"><button id="disclosure-trigger">Details</button><div id="disclosure-content">Body</div></ui-disclosure>
        <ui-tabs id="tabs">
          <button role="tab" id="tab-a" aria-controls="panel-a">A</button>
          <button role="tab" id="tab-b" aria-controls="panel-b">B</button>
          <section role="tabpanel" id="panel-a">Panel A</section>
          <section role="tabpanel" id="panel-b">Panel B</section>
        </ui-tabs>
      `);
      await page.addScriptTag({ path: bundle });
      await page.addScriptTag({ path: controllerBundle });
      const result = await page.evaluate(`(async () => {
        const projected = ['person-a','person-b','person-c','disclosure-trigger','disclosure-content','tab-a','tab-b','panel-a','panel-b']
          .map(id => document.getElementById(id));
        const runtimeErrors = [];
        window.HtmlRuntime.observeDocument(document, { onError(error) { runtimeErrors.push(error.message); }, onConnect(root, definition) {
          const controller = window.LoomaControllers[definition.contract.tag];
          if (controller == null) return;
          window.HtmlRuntime.setControllerModule(root, Promise.resolve(window.LoomaModules[definition.contract.tag]));
          return controller(window.HtmlRuntime.getComponentHost(root));
        }});
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
        const avatar = document.getElementById('avatar');
        const avatars = document.getElementById('avatars');
        const disclosure = document.getElementById('disclosure');
        const trigger = document.getElementById('disclosure-trigger');
        const content = document.getElementById('disclosure-content');
        const tabs = document.getElementById('tabs');
        const events = [];
        disclosure.addEventListener('open', event => events.push(['open', event.detail]));
        tabs.addEventListener('select', event => events.push(['select', event.detail]));
        const avatarFallback = { label: avatar.getAttribute('aria-label'), fallback: avatar.querySelector('.fallback')?.textContent, imageHidden: avatar.querySelector('img')?.hidden };
        avatar.querySelector('img').dispatchEvent(new Event('load'));
        avatar.alt = 'Profile image';
        trigger.click();
        document.getElementById('tab-b').click();
        avatars.max = 1;
        await Promise.resolve(); await Promise.resolve();
        return {
          same: projected.every(node => node === document.getElementById(node.id)),
          avatar: { fallback: avatarFallback, loaded: { label: avatar.getAttribute('aria-label'), imageHidden: avatar.querySelector('img')?.hidden } },
          group: { label: avatars.getAttribute('aria-label'), hidden: ['person-a','person-b','person-c'].map(id => document.getElementById(id).hidden), overflow: avatars.querySelector('[data-ui-avatar-group-overflow]')?.textContent },
          menu: { root: document.getElementById('menu-item').localName, role: document.getElementById('menu-item').getAttribute('role'), value: document.getElementById('menu-item').getAttribute('data-value') },
          disclosure: { expanded: trigger.getAttribute('aria-expanded'), hidden: content.hidden, controls: trigger.getAttribute('aria-controls') },
          tabs: { a: document.getElementById('tab-a').getAttribute('aria-selected'), b: document.getElementById('tab-b').getAttribute('aria-selected'), panelA: document.getElementById('panel-a').hidden, panelB: document.getElementById('panel-b').hidden },
          events, runtimeErrors,
        };
      })()`) as Record<string, unknown>;
      assert.deepEqual(result, {
        same: true,
        avatar: {
          fallback: { label: "Matthew Dean", fallback: "MD", imageHidden: true },
          loaded: { label: "Profile image", imageHidden: false },
        },
        group: { label: "Reviewers", hidden: [false, true, true], overflow: "+2" },
        menu: { root: "button", role: "menuitem", value: "save" },
        disclosure: { expanded: "true", hidden: false, controls: "disclosure-content" },
        tabs: { a: "false", b: "true", panelA: true, panelB: false },
        events: [
          ["open", { open: true, reason: "action", trigger: "programmatic" }],
          ["select", { value: "tab-b", previousValue: "tab-a", trigger: "programmatic" }],
        ],
        runtimeErrors: [],
      });
    } finally {
      await browser.close();
    }
  });

  it("coordinates native overlays, dismissal, notifications, and pointer proximity", { timeout: 15_000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(definitions + `
        <button id="anchor">Anchor</button><ui-popover id="popover" for="anchor" default-open>Popover</ui-popover>
        <button id="tip-anchor">Help</button><ui-tooltip id="tooltip" for="tip-anchor" show-delay="0">Helpful</ui-tooltip>
        <ui-dialog id="dialog" default-open><h2 id="dialog-heading">Confirm</h2><button>Okay</button></ui-dialog>
        <ui-toast-region id="toasts"><article id="toast" data-ui-toast><button id="dismiss" data-ui-toast-dismiss>Dismiss</button></article></ui-toast-region>
        <ui-affordance-scope id="scope" near-radius="20"><button id="affordance" data-ui-affordance style="position:fixed;left:100px;top:100px;width:40px;height:40px">Action</button></ui-affordance-scope>
      `);
      await page.addScriptTag({ path: bundle });
      await page.addScriptTag({ path: controllerBundle });
      await page.evaluate(`(() => {
        window.HtmlRuntime.observeDocument(document, { onConnect(root, definition) {
          const controller = window.LoomaControllers[definition.contract.tag];
          if (controller == null) return;
          window.HtmlRuntime.setControllerModule(root, Promise.resolve(window.LoomaModules[definition.contract.tag]));
          return controller(window.HtmlRuntime.getComponentHost(root));
        }});
        const toasts = document.getElementById('toasts');
        toasts.addEventListener('dismiss', event => document.getElementById(event.detail.id)?.remove());
      })()`);
      await page.waitForTimeout(20);
      await page.evaluate(() => {
        document.getElementById("tip-anchor")?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        document.getElementById("scope")?.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
          clientX: 95,
          clientY: 110,
        }));
      });
      await page.waitForTimeout(20);
      const before = await page.evaluate(() => ({
        popoverHidden: (document.getElementById("popover") as HTMLElement).hidden,
        tooltipHidden: (document.getElementById("tooltip") as HTMLElement).hidden,
        describedBy: document.getElementById("tip-anchor")?.getAttribute("aria-describedby"),
        dialogOpen: Boolean(document.querySelector("#dialog dialog")?.hasAttribute("open")),
        dialogLabel: document.querySelector("#dialog dialog")?.getAttribute("aria-label"),
        locked: document.documentElement.hasAttribute("data-ui-scroll-lock"),
        toastOpen: document.getElementById("toasts")?.hasAttribute("data-open"),
        near: document.getElementById("affordance")?.getAttribute("data-ui-proximity"),
      }));
      await page.evaluate(() => {
        (document.getElementById("tooltip") as HTMLElement & { open?: boolean }).open = false;
        (document.getElementById("dismiss") as HTMLButtonElement).click();
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(20);
      await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        pointerType: "mouse",
      })));
      await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        pointerType: "mouse",
      })));
      await page.waitForTimeout(20);
      const after = await page.evaluate(() => ({
        popoverHidden: (document.getElementById("popover") as HTMLElement).hidden,
        dialogOpen: Boolean(document.querySelector("#dialog dialog")?.hasAttribute("open")),
        locked: document.documentElement.hasAttribute("data-ui-scroll-lock"),
        toastPresent: document.getElementById("toast") !== null,
        toastOpen: document.getElementById("toasts")?.hasAttribute("data-open"),
        stack: (globalThis as unknown as { [key: symbol]: { stack?: Array<{ element?: Element }> } })[Symbol.for("nextwebwg.looma.overlays")]?.stack?.map((entry) => entry.element?.id),
      }));
      assert.deepEqual(before, {
        popoverHidden: false,
        tooltipHidden: false,
        describedBy: "tooltip",
        dialogOpen: true,
        dialogLabel: "Confirm",
        locked: true,
        toastOpen: true,
        near: "near",
      });
      assert.deepEqual(after, {
        popoverHidden: true,
        dialogOpen: false,
        locked: false,
        toastPresent: false,
        toastOpen: false,
        stack: [],
      });
    } finally {
      await browser.close();
    }
  });

  it("supports anchored and point-positioned menu selection with keyboard focus", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(definitions + `
        <button id="menu-anchor">Open</button>
        <ui-menu id="menu" for="menu-anchor" default-open>
          <ui-menu-item id="menu-a" value="a">A</ui-menu-item>
          <ui-menu-item id="menu-b" value="b">B</ui-menu-item>
        </ui-menu>
        <ui-context-menu id="context">
          <button id="context-trigger" slot="trigger">More</button>
          <ui-menu-item id="context-a" value="inspect">Inspect</ui-menu-item>
        </ui-context-menu>
      `);
      await page.addScriptTag({ path: bundle });
      await page.addScriptTag({ path: controllerBundle });
      const result = await page.evaluate(`(async () => {
        const events = [];
        for (const type of ['open','close','select']) document.addEventListener(type, event => {
          if (event.target?.id === 'menu' || event.target?.id === 'context') events.push([event.target.id, type, event.detail]);
        });
        window.HtmlRuntime.observeDocument(document, { onConnect(root, definition) {
          const controller = window.LoomaControllers[definition.contract.tag];
          if (controller == null) return;
          window.HtmlRuntime.setControllerModule(root, Promise.resolve(window.LoomaModules[definition.contract.tag]));
          return controller(window.HtmlRuntime.getComponentHost(root));
        }});
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
        const menu = document.getElementById('menu');
        const anchor = document.getElementById('menu-anchor');
        const initial = { hidden: menu.hidden, expanded: anchor.getAttribute('aria-expanded'), hasPopup: anchor.getAttribute('aria-haspopup') };
        document.getElementById('menu-b').click();
        const context = document.getElementById('context');
        document.getElementById('context-trigger').dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, composed: true, clientX: 140, clientY: 90,
        }));
        await new Promise(resolve => requestAnimationFrame(resolve));
        const opened = {
          hidden: context.querySelector('[data-context-menu-surface]').hidden,
          left: context.querySelector('[data-context-menu-surface]').style.left,
          focused: document.activeElement?.id,
        };
        document.getElementById('context-a').click();
        await Promise.resolve();
        return {
          initial,
          selected: { menuHidden: menu.hidden, anchorExpanded: anchor.getAttribute('aria-expanded') },
          opened,
          contextHidden: context.querySelector('[data-context-menu-surface]').hidden,
          events,
        };
      })()`);
      assert.deepEqual(result, {
        initial: { hidden: false, expanded: "true", hasPopup: "menu" },
        selected: { menuHidden: true, anchorExpanded: "false" },
        opened: { hidden: false, left: "140px", focused: "context-a" },
        contextHidden: true,
        events: [
          ["menu", "select", { value: "b", trigger: "programmatic" }],
          ["menu", "close", { open: false, reason: "action", trigger: "programmatic" }],
          ["context", "open", { open: true, reason: "action", trigger: "pointer" }],
          ["context", "select", { value: "inspect", trigger: "programmatic" }],
          ["context", "close", { open: false, reason: "action", trigger: "programmatic" }],
        ],
      });
    } finally {
      await browser.close();
    }
  });

  it("supports editable focus transitions and accessible tree navigation", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(definitions + `
        <ui-editable id="editable">
          <button id="preview" slot="preview" data-ui-editable-trigger>Rename</button>
          <input id="editor" slot="edit" value="Draft">
        </ui-editable>
        <ui-tree id="tree" label="Files" max-depth="2">
          <ui-tree-item id="parent" item-id="parent" label="Parent" container default-expanded sortable>
            Parent
            <ui-tree-item id="child" slot="children" item-id="child" label="Child">Child</ui-tree-item>
          </ui-tree-item>
          <ui-tree-item id="sibling" item-id="sibling" label="Sibling" sortable>Sibling</ui-tree-item>
        </ui-tree>
      `);
      await page.addScriptTag({ path: bundle });
      await page.addScriptTag({ path: controllerBundle });
      const result = await page.evaluate(`(async () => {
        const events = [];
        for (const type of ['edit-change','expand','reorder-rejected']) document.addEventListener(type, event => events.push([type, event.detail]));
        window.HtmlRuntime.observeDocument(document, { onConnect(root, definition) {
          const controller = window.LoomaControllers[definition.contract.tag];
          if (controller == null) return;
          window.HtmlRuntime.setControllerModule(root, Promise.resolve(window.LoomaModules[definition.contract.tag]));
          return controller(window.HtmlRuntime.getComponentHost(root));
        }});
        await new Promise(resolve => setTimeout(resolve, 0));
        const preview = document.getElementById('preview');
        preview.click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        const editOpened = { focused: document.activeElement?.id, previewHidden: preview.closest('.editable__preview').hidden };
        document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
        await new Promise(resolve => requestAnimationFrame(resolve));
        const editClosed = { focused: document.activeElement?.id === 'preview', editorHidden: document.getElementById('editor').closest('.editable__editor').hidden };
        const parent = document.getElementById('parent');
        const child = document.getElementById('child');
        parent.focus();
        parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }));
        const treeMoved = document.activeElement?.id;
        parent.querySelector('.tree-item__disclosure').click();
        parent.dropDepth = 2;
        const sibling = document.getElementById('sibling');
        const handle = sibling.querySelector('.tree-item__drag');
        const transfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, composed: true, dataTransfer: transfer }));
        const rowRect = parent.querySelector('.tree-item__row').getBoundingClientRect();
        parent.dispatchEvent(new DragEvent('dragover', { bubbles: true, composed: true, dataTransfer: transfer, clientY: rowRect.top + rowRect.height / 2 }));
        document.getElementById('tree').dispatchEvent(new DragEvent('dragend', { bubbles: true, composed: true, dataTransfer: transfer }));
        return {
          editOpened,
          editClosed,
          tree: {
            role: document.getElementById('tree').getAttribute('role'),
            label: document.getElementById('tree').getAttribute('aria-label'),
            parentLevel: parent.getAttribute('aria-level'),
            childLevel: child.getAttribute('aria-level'),
            moved: treeMoved,
            expanded: parent.getAttribute('aria-expanded'),
            childHidden: child.closest('.tree-item__children').hidden,
          },
          events,
        };
      })()`);
      assert.deepEqual(result, {
        editOpened: { focused: "editor", previewHidden: true },
        editClosed: { focused: true, editorHidden: true },
        tree: { role: "tree", label: "Files", parentLevel: "1", childLevel: "2", moved: "child", expanded: "false", childHidden: true },
        events: [
          ["edit-change", { edit: true, reason: "activate", trigger: "programmatic" }],
          ["edit-change", { edit: false, reason: "escape", trigger: "keyboard" }],
          ["expand", { id: "parent", expanded: false, trigger: "programmatic" }],
          ["reorder-rejected", { sourceId: "sibling", targetId: "parent", position: "inside", reason: "max-depth", maxDepth: 2, resultingDepth: 3, trigger: "pointer" }],
        ],
      });
    } finally {
      await browser.close();
    }
  });

  it("implements async native comboboxes, data-derived slots, methods, and validation", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(definitions + `
        <ui-combobox id="combo" label="Country" name="country" clearable disclosure required>
          <strong id="custom-us" slot="option-us">United States custom</strong>
        </ui-combobox>
        <ui-multi-combobox id="multi" label="People" name="people">
          <strong id="custom-person" slot="item-person">Custom Person</strong>
        </ui-multi-combobox>
      `);
      await page.evaluate(`(() => {
        const combo = document.getElementById("combo");
        combo.config = {
          debounce: 0,
          provider: async ({ query, signal }) => {
            await Promise.resolve();
            signal.throwIfAborted();
            return [
              { id: "us", value: "US", label: "United States" },
              { id: "ca", value: "CA", label: "Canada" },
            ].filter((row) => row.label.toLowerCase().includes(query.toLowerCase()));
          },
        };
        const multi = document.getElementById("multi");
        multi.items = [{ id: "person", value: "p1", label: "Person One" }];
        multi.tokenSeparators = [","];
        multi.config = { options: [{ id: "two", value: "p2", label: "Person Two" }], allowCreate: true };
      })()`);
      await page.addScriptTag({ path: bundle });
      await page.addScriptTag({ path: controllerBundle });
      const result = await page.evaluate(`(async () => {
        const events = [];
        for (const type of ['query-change','value-change','validation-change','add-item','remove-item','create-item']) {
          document.addEventListener(type, event => events.push([event.target.id, type, event.detail]));
        }
        window.HtmlRuntime.observeDocument(document, { onConnect(root, definition) {
          const module = window.LoomaModules[definition.contract.tag];
          if (module == null) return;
          window.HtmlRuntime.setControllerModule(root, Promise.resolve(module));
          return module.default(window.HtmlRuntime.getComponentHost(root));
        }});
        await new Promise(resolve => setTimeout(resolve, 0));
        const combo = document.getElementById('combo');
        const comboInput = combo.querySelector('input[role=combobox]');
        if (!comboInput) throw new Error(combo.outerHTML);
        comboInput.value = 'uni';
        comboInput.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: 'i' }));
        await new Promise(resolve => setTimeout(resolve, 10));
        const custom = document.getElementById('custom-us');
        const customSame = combo.querySelector('#custom-us') === custom;
        combo.querySelector('[role=option][data-index="0"]').click();
        const valid = await combo.validate();
        combo.querySelector('.combobox__clear').click();
        const invalid = await combo.validate();
        await combo.focusInput();

        const multi = document.getElementById('multi');
        const item = document.getElementById('custom-person');
        const itemSame = multi.querySelector('#custom-person') === item;
        const multiInput = multi.querySelector('input[role=combobox]');
        multiInput.value = 'person';
        multiInput.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        multi.querySelector('[role=option][data-index="0"]').click();
        multi.querySelector('.multi-combobox__item').click();
        await multi.focusInput();
        return {
          combo: {
            customSame,
            value: combo.value,
            inputValue: comboInput.value,
            validStatus: valid.status,
            invalidStatus: invalid.status,
            validationMessage: comboInput.validationMessage,
            focused: document.activeElement === multiInput,
          },
          multi: { itemSame, hiddenValues: Array.from(multi.querySelectorAll('input[type=hidden]'), input => input.value) },
          events: events.filter(([, type]) => type !== 'validation-change' && type !== 'query-change').map(([id, type, detail]) => [id, type, detail]),
        };
      })()`);
      assert.deepEqual(result, {
        combo: {
          customSame: true,
          value: undefined,
          inputValue: "",
          validStatus: "valid",
          invalidStatus: "error",
          validationMessage: "A value is required.",
          focused: true,
        },
        multi: { itemSame: true, hiddenValues: ["p1"] },
        events: [
          ["combo", "value-change", { value: "US", query: "United States", option: { id: "us", value: "US", label: "United States" }, kind: "selection", trigger: "programmatic" }],
          ["combo", "value-change", { value: null, query: "", option: null, kind: "clear", trigger: "pointer" }],
          ["multi", "add-item", { item: { id: "two", value: "p2", label: "Person Two" }, index: 1, trigger: "programmatic" }],
          ["multi", "remove-item", { item: { id: "person", value: "p1", label: "Person One" }, index: 0, trigger: "programmatic" }],
        ],
      });
    } finally {
      await browser.close();
    }
  });

  after(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("uses native controls and preserves structured projected content", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(definitions + `
        <ui-button id="button" disabled variant="solid"><span id="button-label">Save</span></ui-button>
        <ui-icon-button id="icon" label="Settings"><svg id="icon-node"></svg></ui-icon-button>
        <ui-callout id="callout" tone="warning"><p id="message">Careful</p></ui-callout>
        <ui-chip id="chip" appearance="pill">Tag</ui-chip>
        <ui-badge id="badge" tone="positive">Ready</ui-badge>
        <ui-search-shell id="search"><input id="search-input" slot="search"><p id="search-body" slot="body">Result</p></ui-search-shell>
        <ui-search-result-row id="row" selected><strong id="row-title" slot="title">Title</strong></ui-search-result-row>
        <ui-top-bar id="top"><strong id="top-title">Workspace</strong><button id="top-action" slot="actions">Add</button></ui-top-bar>
        <ui-form-field id="field" label="Email" required><input id="field-input" type="email"></ui-form-field>
      `);
      await page.addScriptTag({ path: bundle });
      const result = await page.evaluate(() => {
        const original = ["button-label", "icon-node", "message", "search-input", "search-body", "row-title", "top-title", "top-action", "field-input"]
          .map((id) => document.getElementById(id));
        (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
        return {
          roots: ["button", "icon", "callout", "chip", "badge", "search", "row", "top", "field"]
            .map((id) => document.getElementById(id)?.localName),
          same: original.every((node) => node === document.getElementById(node!.id)),
          disabled: (document.getElementById("button") as HTMLButtonElement).disabled,
          variant: document.getElementById("button")?.getAttribute("data-variant"),
          iconLabel: document.getElementById("icon")?.getAttribute("aria-label"),
          callout: [document.getElementById("callout")?.getAttribute("role"), document.getElementById("callout")?.getAttribute("data-tone")],
          selected: document.getElementById("row")?.getAttribute("aria-selected"),
          fieldLegend: document.querySelector("#field legend")?.textContent,
        };
      });
      assert.deepEqual(result, {
        roots: ["button", "button", "aside", "span", "span", "div", "button", "header", "fieldset"],
        same: true,
        disabled: true,
        variant: "solid",
        iconLabel: "Settings",
        callout: ["note", "warning"],
        selected: "",
        fieldLegend: "Email",
      });
    } finally {
      await browser.close();
    }
  });

  it("applies migrated Looma CSS to lowered native roots", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<style>${compatibilityStyles}</style>${definitions}<ui-button id="styled" variant="solid">Save</ui-button>`);
      await page.addScriptTag({ path: bundle });
      const result = await page.evaluate(() => {
        (window as unknown as { HtmlRuntime: { lowerDocument(): number } }).HtmlRuntime.lowerDocument();
        const button = document.getElementById("styled")!;
        const style = getComputedStyle(button);
        return { tag: button.localName, minBlockSize: style.minBlockSize, display: style.display, variant: button.getAttribute("data-variant") };
      });
      assert.deepEqual(result, { tag: "button", minBlockSize: "40px", display: "inline-flex", variant: "solid" });
    } finally {
      await browser.close();
    }
  });
});
