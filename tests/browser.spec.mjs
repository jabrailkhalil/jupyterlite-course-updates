import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = (process.env.JUPYTERLITE_BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const EXPECTED_PYODIDE = process.env.EXPECTED_PYODIDE_VERSION || '314.0.6';
const ORIGINAL = 'lesson.ipynb';
const LEARNER_SOURCE = 'answer = sum([2, 3, 5])\nprint("learner:", answer)';
const INCOMING_SOURCE = 'answer = 2 + 3 + 5\nprint("author:", answer)';
const UPDATED_INSTRUCTIONS = 'Add 2, 3, and 5. Store the result in answer and explain your method.';
const source = value => Array.isArray(value) ? value.join('') : value;
const fixture = version => JSON.parse(readFileSync(fileURLToPath(new URL(
  `../fixtures/course-assets/v${version}/lesson.ipynb`, import.meta.url
)), 'utf8'));

async function withBrowser(testInfo, run) {
  const profile = mkdtempSync(join(tmpdir(), 'course-update-browser-'));
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const evidence = { externalRequests: [], console: [], runtime: null, transport: null, transportSessions: [] };
  mkdirSync('artifacts', { recursive: true });
  let context;
  let page;
  const start = async () => {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ['--no-sandbox'],
      serviceWorkers: 'allow',
      viewport: { width: 1440, height: 1000 }
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(SITE).origin && !['blob:', 'data:'].includes(url.protocol)) {
        evidence.externalRequests.push(url.href);
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    });
    page = context.pages()[0] || await context.newPage();
    page.on('console', message => evidence.console.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', error => evidence.console.push({ type: 'pageerror', text: error.message }));
    await page.goto(`${SITE}/lab/index.html`);
    await page.waitForFunction(() => Boolean(window.jupyterapp));
    await page.evaluate(async () => {
      const app = window.jupyterapp;
      await app.started;
      await app.restored;
      await app.serviceManager.ready;
    });
    expect(await page.evaluate(() => window.crossOriginIsolated), 'the declared release transport requires a non-COI page').toBe(false);
    await page.waitForFunction(async () => {
      const workers = navigator.serviceWorker;
      if (!workers?.controller || workers.controller.state !== 'activated') return false;
      const registration = await workers.getRegistration();
      return registration?.active?.state === 'activated'
        && registration.active.scriptURL === workers.controller.scriptURL;
    }, null, { timeout: 30000 });
    const transport = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const controller = navigator.serviceWorker.controller;
      if (!controller || !registration?.active) throw new Error('An active controlling ServiceWorker is required');
      return {
        crossOriginIsolated: window.crossOriginIsolated,
        serviceWorkerScriptURL: controller.scriptURL,
        serviceWorkerState: controller.state,
        serviceWorkerScope: registration.scope,
        activeServiceWorkerScriptURL: registration.active.scriptURL,
        activeServiceWorkerState: registration.active.state,
        sharedArrayBufferType: typeof SharedArrayBuffer
      };
    });
    expect(transport.crossOriginIsolated).toBe(false);
    expect(transport.serviceWorkerState).toBe('activated');
    expect(transport.activeServiceWorkerState).toBe('activated');
    expect(transport.serviceWorkerScriptURL).toBe(transport.activeServiceWorkerScriptURL);
    expect(new URL(transport.serviceWorkerScriptURL).origin).toBe(new URL(SITE).origin);
    evidence.transport = transport;
    evidence.transportSessions.push(transport);
    return page;
  };
  try {
    await start();
    await run({
      get page() { return page; },
      evidence,
      async restart() {
        await context.close();
        return start();
      }
    });
    expect(evidence.externalRequests, 'all observed runtime requests must stay on the local site').toEqual([]);
  } finally {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: `artifacts/${slug}.png`, fullPage: true }).catch(() => {});
    }
    writeFileSync(`artifacts/${slug}-evidence.json`, JSON.stringify(evidence, null, 2));
    if (context) await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

async function openNotebook(page, path = ORIGINAL) {
  await page.evaluate(async path => {
    const app = window.jupyterapp;
    const panel = await app.commands.execute('docmanager:open', { path, factory: 'Notebook' });
    if (!panel?.context) throw new Error(`Notebook panel did not open: ${path}`);
    await panel.context.ready;
    if (!panel.content?.model) throw new Error(`Notebook model did not load: ${path}`);
    app.shell.activateById(panel.id);
  }, path);
  await expect(page.getByRole('button', { name: 'Review course update', exact: true })).toBeVisible();
}

async function notebookJSON(page, path = ORIGINAL) {
  return page.evaluate(path => {
    const app = window.jupyterapp;
    const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === path);
    if (!panel?.content?.model) throw new Error(`Notebook model not found: ${path}`);
    return JSON.parse(panel.content.model.toString());
  }, path);
}

async function storedJSON(page, path) {
  return page.evaluate(async path => {
    const model = await window.jupyterapp.serviceManager.contents.get(path, { content: true });
    const content = typeof model.content === 'string' ? JSON.parse(model.content) : model.content;
    return JSON.parse(JSON.stringify(content));
  }, path);
}

async function setAnswer(page, value, path = ORIGINAL) {
  await page.evaluate(({ path, value }) => {
    const app = window.jupyterapp;
    const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === path);
    if (!panel?.content?.model) throw new Error(`Notebook model not found: ${path}`);
    panel.content.model.cells.get(1).sharedModel.setSource(value);
    panel.content.activeCellIndex = 1;
  }, { path, value });
}

async function executeAnswer(page, path = ORIGINAL) {
  await openNotebook(page, path);
  const expectedSource = source((await notebookJSON(page, path)).cells[1].source);
  await expect.poll(() => page.evaluate(path => {
    const app = window.jupyterapp;
    const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === path);
    return Boolean(panel?.isAttached && panel.isVisible
      && app.shell.currentWidget === panel
      && app.commands.isEnabled('notebook:run-cell')
      && panel.content.widgets.length === 2);
  }, path)).toBe(true);
  const target = await page.evaluate(async path => {
    const app = window.jupyterapp;
    const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === path);
    if (!panel?.sessionContext) throw new Error(`Notebook session not found: ${path}`);
    await panel.sessionContext.ready;
    if (!panel.sessionContext.session?.kernel) throw new Error(`Notebook kernel is not ready: ${path}`);
    panel.content.deselectAll();
    panel.content.activeCellIndex = 1;
    return {
      path: panel.context.path,
      currentPath: app.shell.currentWidget?.context?.path,
      commandEnabled: app.commands.isEnabled('notebook:run-cell'),
      index: panel.content.activeCellIndex,
      id: panel.content.activeCell?.model.id,
      type: panel.content.activeCell?.model.type,
      source: panel.content.activeCell?.model.sharedModel.getSource(),
      selectedCellIds: panel.content.selectedCells.map(cell => cell.model.id)
    };
  }, path);
  expect(target).toEqual({ path, currentPath: path, commandEnabled: true, index: 1,
    id: 'answer', type: 'code', source: expectedSource, selectedCellIds: ['answer'] });
  const result = await page.evaluate(async ({ path, expectedSource }) => {
    const app = window.jupyterapp;
    const panel = app.shell.currentWidget;
    const cell = panel?.content?.activeCell;
    if (panel?.context?.path !== path || !app.commands.isEnabled('notebook:run-cell')
      || cell?.model.id !== 'answer' || cell.model.type !== 'code'
      || cell.model.sharedModel.getSource() !== expectedSource) {
      throw new Error(`Notebook lost its selected answer execution target: ${path}`);
    }
    return app.commands.execute('notebook:run-cell');
  }, { path, expectedSource });
  expect(result, 'the actual Notebook Run command must execute successfully, not return a no-op').toBe(true);
}

async function runtimeProbe(page) {
  return page.evaluate(async () => {
    const panel = window.jupyterapp.shell.currentWidget;
    await panel.sessionContext.ready;
    const kernel = panel.sessionContext.session?.kernel;
    if (!kernel) throw new Error('No real notebook kernel is running');
    let stdout = '';
    const future = kernel.requestExecute({
      code: 'import json, sys, pyodide\nprint(json.dumps({"platform": sys.platform, "python": sys.version.split()[0], "pyodide": pyodide.__version__, "answer": globals().get("answer")}))',
      store_history: false,
      stop_on_error: true
    });
    future.onIOPub = message => {
      if (message.header.msg_type === 'stream') stdout += message.content.text;
    };
    const reply = await future.done;
    if (reply.content.status !== 'ok') throw new Error(`Kernel probe failed: ${JSON.stringify(reply.content)}`);
    return JSON.parse(stdout.trim());
  });
}

async function beginReview(page, label) {
  await page.getByRole('button', { name: 'Review course update', exact: true }).click();
  const review = page.locator('[data-course-update-review]:visible').last();
  await expect(review).toBeVisible();
  await expect(review.getByRole('button', { name: 'Preview update', exact: true })).toBeEnabled();
  await review.getByRole('combobox', { name: 'Course update version', exact: true }).selectOption({ label });
  await review.getByRole('button', { name: 'Preview update', exact: true }).click();
  await expect(review.locator('[data-cell-id="answer"]')).toBeVisible();
  return review;
}

async function copyReceipt(review) {
  await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeEnabled();
  await review.getByRole('button', { name: 'Create updated copy', exact: true }).click();
  const receipt = review.locator('[data-output-path]');
  await expect(receipt).toHaveCount(1);
  const path = await receipt.getAttribute('data-output-path');
  const run = await receipt.getAttribute('data-run-path');
  expect(path).toMatch(/^course-update-[^/]+\/updated\.ipynb$/);
  expect(path).not.toBe(ORIGINAL);
  expect(run).toBe(path.slice(0, path.lastIndexOf('/')));
  return { path, run };
}

function outputText(notebook) {
  return notebook.cells[1].outputs
    .filter(output => output.output_type === 'stream')
    .map(output => source(output.text))
    .join('');
}

async function deferActualSave(page, suffix) {
  return page.evaluateHandle(suffix => {
    const contents = window.jupyterapp.serviceManager.contents;
    const original = contents.save;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const gate = { path: null, release, restore: null };
    const wrapped = async function (path, options) {
      const result = await original.call(this, path, options);
      if (gate.path === null && path.endsWith(suffix)) {
        gate.path = path;
        await pending;
      }
      return result;
    };
    contents.save = wrapped;
    gate.restore = () => {
      if (contents.save === wrapped) contents.save = original;
    };
    return gate;
  }, suffix);
}

async function contentsMissing(page, path) {
  return page.evaluate(async path => {
    try {
      await window.jupyterapp.serviceManager.contents.get(path, { content: true });
      return false;
    } catch (error) {
      if (error?.response?.status === 404) return true;
      throw error;
    }
  }, path);
}

async function renderedLines(pre) {
  return pre.locator('.jp-CourseUpdate-line').evaluateAll(lines => lines.map(line => ({
    text: line.querySelector('.jp-CourseUpdate-lineText')?.textContent,
    change: line.dataset.change
  })));
}

async function previewSource(row) {
  const lines = await renderedLines(row.getByLabel('Updated copy preview', { exact: true }));
  return lines.map(line => line.text).join('\n');
}

async function expectNoHorizontalOverflow(page, review) {
  const documentSize = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(documentSize.html, 'the real app document must fit its viewport').toBeLessThanOrEqual(documentSize.viewport + 1);
  expect(documentSize.body, 'the real app body must fit its viewport').toBeLessThanOrEqual(documentSize.viewport + 1);
  const widgetSize = await review.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
  expect(widgetSize.scroll, 'the review must wrap its source panes without horizontal overflow').toBeLessThanOrEqual(widgetSize.width + 1);
}

test('separate edits create a persistent updated copy with a real Pyodide answer', async ({}, testInfo) => {
  await withBrowser(testInfo, async session => {
    let page = session.page;
    await openNotebook(page);
    const originalStored = await storedJSON(page, ORIGINAL);
    await setAnswer(page, LEARNER_SOURCE);
    await executeAnswer(page);
    await expect.poll(async () => outputText(await notebookJSON(page))).toBe('learner: 10\n');
    const runtime = await runtimeProbe(page);
    expect(runtime.platform).toBe('emscripten');
    expect(runtime.pyodide).toBe(EXPECTED_PYODIDE);
    expect(runtime.python).toMatch(/^3\.14\./);
    expect(runtime.answer).toBe(10);
    session.evidence.runtime = runtime;
    const learnerSnapshot = await notebookJSON(page);
    const review = await beginReview(page, 'Updated instructions');
    await expect(review.getByRole('radio')).toHaveCount(0);
    const { path, run } = await copyReceipt(review);
    await expect(review.getByRole('status')).toContainText('Your original notebook is unchanged');
    const updated = await storedJSON(page, path);
    expect(source(updated.cells[0].source)).toBe(UPDATED_INSTRUCTIONS);
    expect(source(updated.cells[1].source)).toBe(LEARNER_SOURCE);
    expect(updated.cells[1].outputs).toEqual(learnerSnapshot.cells[1].outputs);
    expect(updated.cells[1].execution_count).toBe(learnerSnapshot.cells[1].execution_count);
    expect(await storedJSON(page, ORIGINAL)).toEqual(originalStored);
    expect(source((await notebookJSON(page)).cells[1].source)).toBe(LEARNER_SOURCE);
    await review.getByRole('button', { name: 'Open updated notebook', exact: true }).click();
    await expect.poll(async () => page.evaluate(() => window.jupyterapp.shell.currentWidget?.context?.path)).toBe(path);
    await page.screenshot({ path: 'artifacts/course-updated-copy.png', fullPage: true });
    await page.screenshot({ path: 'artifacts/course-updated-notebook-1440.png', fullPage: true });
    await page.setViewportSize({ width: 720, height: 1000 });
    await page.screenshot({ path: 'artifacts/course-updated-notebook-720.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    writeFileSync('artifacts/browser-updated-notebook.json', JSON.stringify(updated, null, 2));
    page = await session.restart();
    expect(await storedJSON(page, path)).toEqual(updated);
    expect(await storedJSON(page, ORIGINAL)).toEqual(originalStored);
    expect(await storedJSON(page, `${run}/base.ipynb`)).toEqual(fixture(1));
    expect(await storedJSON(page, `${run}/learner.ipynb`)).toEqual(learnerSnapshot);
    expect(await storedJSON(page, `${run}/incoming.ipynb`)).toEqual(fixture(2));
    const receipt = await storedJSON(page, `${run}/receipt.json`);
    expect(receipt.originalPath).toBe(ORIGINAL);
    expect(receipt.outputPath).toBe(path);
    expect(receipt.incomingVersion).toBe('2');
    await openNotebook(page, path);
    await executeAnswer(page, path);
    await expect.poll(async () => outputText(await notebookJSON(page, path))).toBe('learner: 10\n');
    const restartedRuntime = await runtimeProbe(page);
    expect(restartedRuntime.platform).toBe('emscripten');
    expect(restartedRuntime.pyodide).toBe(EXPECTED_PYODIDE);
    expect(restartedRuntime.python).toMatch(/^3\.14\./);
    expect(restartedRuntime.answer).toBe(10);
    session.evidence.restartedRuntime = restartedRuntime;
  });
});

test('same-cell conflict keeps all three versions and requires a learner choice', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page }) => {
    await openNotebook(page);
    const before = await storedJSON(page, ORIGINAL);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Worked example');
    const row = review.locator('[data-cell-id="answer"]');
    await expect(row.getByLabel('Base version', { exact: true })).toContainText('answer = None');
    await expect(row.getByLabel('Your work', { exact: true })).toContainText('learner:');
    await expect(row.getByLabel('Course update', { exact: true })).toContainText('author:');
    await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeDisabled();
    await expect(review.locator('[data-output-path]')).toHaveCount(0);
    expect(await storedJSON(page, ORIGINAL)).toEqual(before);
    await row.getByRole('radio', { name: 'Keep my answer', exact: true }).check();
    const { path } = await copyReceipt(review);
    const result = await storedJSON(page, path);
    expect(source(result.cells[1].source)).toBe(LEARNER_SOURCE);
    expect(source(result.cells[0].source)).toBe(UPDATED_INSTRUCTIONS);
    expect(await storedJSON(page, ORIGINAL)).toEqual(before);
  });
});

test('choosing course code clears stale execution before the user runs it', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page }) => {
    await openNotebook(page);
    const before = await storedJSON(page, ORIGINAL);
    await setAnswer(page, LEARNER_SOURCE);
    await executeAnswer(page);
    await expect.poll(async () => outputText(await notebookJSON(page))).toBe('learner: 10\n');
    const review = await beginReview(page, 'Worked example');
    await review.getByRole('radio', { name: 'Use course answer', exact: true }).check();
    const { path } = await copyReceipt(review);
    const result = await storedJSON(page, path);
    expect(source(result.cells[1].source)).toBe(INCOMING_SOURCE);
    expect(result.cells[1].outputs).toEqual([]);
    expect(result.cells[1].execution_count).toBeNull();
    expect(await storedJSON(page, ORIGINAL)).toEqual(before);
    await review.getByRole('button', { name: 'Open updated notebook', exact: true }).click();
    await expect.poll(async () => page.evaluate(() => window.jupyterapp.shell.currentWidget?.context?.path)).toBe(path);
    expect((await notebookJSON(page, path)).cells[1].outputs).toEqual([]);
    await executeAnswer(page, path);
    await expect.poll(async () => outputText(await notebookJSON(page, path))).toBe('author: 10\n');
  });
});

test('cancel leaves the original and its unsaved learner model intact', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page }) => {
    await openNotebook(page);
    const before = await storedJSON(page, ORIGINAL);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Worked example');
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('[data-course-update-review]')).toHaveCount(0);
    expect(await storedJSON(page, ORIGINAL)).toEqual(before);
    expect(source((await notebookJSON(page)).cells[1].source)).toBe(LEARNER_SOURCE);
    const directory = await page.evaluate(async () => window.jupyterapp.serviceManager.contents.get('', { content: true }));
    expect(directory.content.filter(item => item.name.startsWith('course-update-'))).toEqual([]);
  });
});

test('stale active model refuses a successful updated copy', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page }) => {
    await openNotebook(page);
    const before = await storedJSON(page, ORIGINAL);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Updated instructions');
    await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeEnabled();
    await setAnswer(page, 'answer = 7 # changed after preview');
    await review.getByRole('button', { name: 'Create updated copy', exact: true }).click();
    await expect(review.getByRole('status')).toContainText(/\bchanged\b|\bstale\b|preview.*again|review.*again/i);
    await expect(review.locator('[data-output-path]')).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Open updated notebook', exact: true })).toHaveCount(0);
    expect(source((await notebookJSON(page)).cells[1].source)).toBe('answer = 7 # changed after preview');
    expect(await storedJSON(page, ORIGINAL)).toEqual(before);
  });
});

test('stale persisted content refuses a successful updated copy', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page }) => {
    await openNotebook(page);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Updated instructions');
    await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeEnabled();
    await page.evaluate(async path => {
      const contents = window.jupyterapp.serviceManager.contents;
      const stored = await contents.get(path, { content: true });
      const content = typeof stored.content === 'string' ? JSON.parse(stored.content) : stored.content;
      content.cells[1].source = 'answer = 8 # another writer saved this';
      content.cells[1].outputs = [];
      content.cells[1].execution_count = null;
      await contents.save(path, { type: 'notebook', format: 'json', content });
    }, ORIGINAL);
    await review.getByRole('button', { name: 'Create updated copy', exact: true }).click();
    await expect(review.getByRole('status')).toContainText(/\bchanged\b|\bstale\b|preview.*again|review.*again/i);
    await expect(review.locator('[data-output-path]')).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Open updated notebook', exact: true })).toHaveCount(0);
    expect(source((await storedJSON(page, ORIGINAL)).cells[1].source)).toBe('answer = 8 # another writer saved this');
  });
});

test('stale edit during a real updated save removes its incomplete run and preserves dirty work', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    await openNotebook(page);
    const before = await storedJSON(page, ORIGINAL);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Updated instructions');
    const gate = await deferActualSave(page, '/updated.ipynb');
    try {
      await review.getByRole('button', { name: 'Create updated copy', exact: true }).click();
      await expect.poll(() => gate.evaluate(gate => gate.path)).toMatch(/^course-update-[^/]+\/updated\.ipynb$/);
      const path = await gate.evaluate(gate => gate.path);
      const run = path.slice(0, path.lastIndexOf('/'));
      expect(source((await storedJSON(page, path)).cells[1].source)).toBe(LEARNER_SOURCE);
      const changed = 'answer = 14 # edited while the new copy was saving';
      await setAnswer(page, changed);
      await gate.evaluate(gate => gate.release());
      await expect(review.getByRole('status')).toContainText(/\bchanged\b|\bstale\b|preview.*again|review.*again/i);
      await expect(review.locator('[data-output-path]')).toHaveCount(0);
      await expect(review.getByRole('button', { name: 'Open updated notebook', exact: true })).toHaveCount(0);
      expect(await contentsMissing(page, run)).toBe(true);
      expect(await contentsMissing(page, path)).toBe(true);
      expect(await contentsMissing(page, `${run}/receipt.json`)).toBe(true);
      const root = await page.evaluate(async () => window.jupyterapp.serviceManager.contents.get('', { content: true }));
      expect(root.content.some(item => item.path === run)).toBe(false);
      expect(source((await notebookJSON(page)).cells[1].source)).toBe(changed);
      expect(await page.evaluate(path => [...window.jupyterapp.shell.widgets('main')]
        .find(widget => widget.context?.path === path)?.content?.model?.dirty, ORIGINAL)).toBe(true);
      expect(await storedJSON(page, ORIGINAL)).toEqual(before);
      evidence.awaitBoundary = { method: 'save', path, realSavedCopyRead: true, incompleteRunRemoved: true };
    } finally {
      await gate.evaluate(gate => { gate.release(); gate.restore(); });
      await gate.dispose();
    }
  });
});

test('conflict radios stay disabled during a real save and the receipt retains the reviewed choice', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    await openNotebook(page);
    const before = await storedJSON(page, ORIGINAL);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Worked example');
    await review.getByRole('radio', { name: 'Keep my answer', exact: true }).check();
    const gate = await deferActualSave(page, '/learner.ipynb');
    try {
      await review.getByRole('button', { name: 'Create updated copy', exact: true }).click();
      await expect.poll(() => gate.evaluate(gate => gate.path)).toMatch(/^course-update-[^/]+\/learner\.ipynb$/);
      const snapshotPath = await gate.evaluate(gate => gate.path);
      expect(source((await storedJSON(page, snapshotPath)).cells[1].source)).toBe(LEARNER_SOURCE);
      const radios = review.getByRole('radio');
      await expect(radios).toHaveCount(2);
      for (let index = 0; index < await radios.count(); index++) await expect(radios.nth(index)).toBeDisabled();
      await expect(review.getByRole('radio', { name: 'Keep my answer', exact: true })).toBeChecked();
      await expect(review.getByRole('radio', { name: 'Use course answer', exact: true })).not.toBeChecked();
      await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeDisabled();
      await gate.evaluate(gate => gate.release());
      const receiptNode = review.locator('[data-output-path]');
      await expect(receiptNode).toHaveCount(1);
      const path = await receiptNode.getAttribute('data-output-path');
      const run = await receiptNode.getAttribute('data-run-path');
      expect(path).toBe(`${run}/updated.ipynb`);
      const receipt = await storedJSON(page, `${run}/receipt.json`);
      expect(receipt.choices).toEqual({ answer: 'learner' });
      expect(receipt.outputPath).toBe(path);
      expect(source((await storedJSON(page, path)).cells[1].source)).toBe(LEARNER_SOURCE);
      expect(await storedJSON(page, ORIGINAL)).toEqual(before);
      evidence.awaitBoundary = { method: 'save', path: snapshotPath, realSavedSnapshotRead: true, allConflictRadiosDisabled: true };
    } finally {
      await gate.evaluate(gate => { gate.release(); gate.restore(); });
      await gate.dispose();
    }
  });
});

test('moving the original into an incomplete run during a real save preserves that notebook and its folder', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    await openNotebook(page);
    const before = await storedJSON(page, ORIGINAL);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Updated instructions');
    const gate = await deferActualSave(page, '/updated.ipynb');
    try {
      await review.getByRole('button', { name: 'Create updated copy', exact: true }).click();
      await expect.poll(() => gate.evaluate(gate => gate.path)).toMatch(/^course-update-[^/]+\/updated\.ipynb$/);
      const path = await gate.evaluate(gate => gate.path);
      const run = path.slice(0, path.lastIndexOf('/'));
      expect(source((await storedJSON(page, path)).cells[1].source)).toBe(LEARNER_SOURCE);
      const moved = `${run}/moved-lesson.ipynb`;
      await page.evaluate(async ({ original, moved }) => {
        const app = window.jupyterapp;
        const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === original);
        if (!panel?.context) throw new Error('Original notebook context is missing');
        await panel.context.rename(moved);
        if (panel.context.path !== moved) throw new Error('The real notebook context did not follow its rename');
      }, { original: ORIGINAL, moved });
      expect(await storedJSON(page, moved)).toEqual(before);
      expect(source((await notebookJSON(page, moved)).cells[1].source)).toBe(LEARNER_SOURCE);
      await gate.evaluate(gate => gate.release());
      await expect(review.getByRole('status')).toContainText(/\bchanged\b|\bstale\b|preview.*again|review.*again/i);
      await expect(review.getByRole('status')).toContainText(/mov(?:ed|ing)|relocat/i);
      await expect(review.getByRole('status')).toContainText(/incomplete/i);
      await expect(review.locator('[data-output-path]')).toHaveCount(0);
      await expect(review.getByRole('button', { name: 'Open updated notebook', exact: true })).toHaveCount(0);
      expect(await storedJSON(page, moved)).toEqual(before);
      expect(source((await notebookJSON(page, moved)).cells[1].source)).toBe(LEARNER_SOURCE);
      expect(await page.evaluate(path => [...window.jupyterapp.shell.widgets('main')]
        .find(widget => widget.context?.path === path)?.content?.model?.dirty, moved)).toBe(true);
      expect(await contentsMissing(page, path)).toBe(true);
      expect(await contentsMissing(page, `${run}/receipt.json`)).toBe(true);
      const folder = await page.evaluate(async run => window.jupyterapp.serviceManager.contents.get(run, { content: true }), run);
      expect(folder.type).toBe('directory');
      expect(folder.content.some(item => item.path === moved)).toBe(true);
      evidence.awaitBoundary = { method: 'save', path, originalMovedTo: moved, realMovedOriginalRead: true, containingFolderPreserved: true };
    } finally {
      await gate.evaluate(gate => { gate.release(); gate.restore(); });
      await gate.dispose();
    }
  });
});

test('an ordinary saved learner notebook can create an updated copy without changing its saved work', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    await openNotebook(page);
    await setAnswer(page, LEARNER_SOURCE);
    expect(await page.evaluate(path => [...window.jupyterapp.shell.widgets('main')]
      .find(widget => widget.context?.path === path)?.content?.model?.dirty, ORIGINAL)).toBe(true);
    await page.evaluate(async path => {
      const app = window.jupyterapp;
      const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === path);
      if (!panel?.context) throw new Error('Original notebook context is missing');
      await panel.context.save();
      if (panel.content.model.dirty) throw new Error('The real document save did not clear the dirty state');
    }, ORIGINAL);
    const saved = await storedJSON(page, ORIGINAL);
    expect(source(saved.cells[1].source)).toBe(LEARNER_SOURCE);
    expect(await notebookJSON(page)).toEqual(saved);
    const review = await beginReview(page, 'Updated instructions');
    await expect(review.getByRole('radio')).toHaveCount(0);
    const { path } = await copyReceipt(review);
    const updated = await storedJSON(page, path);
    expect(source(updated.cells[0].source)).toBe(UPDATED_INSTRUCTIONS);
    expect(source(updated.cells[1].source)).toBe(LEARNER_SOURCE);
    expect(updated.cells[1].outputs).toEqual(saved.cells[1].outputs);
    expect(updated.cells[1].execution_count).toBe(saved.cells[1].execution_count);
    expect(await storedJSON(page, ORIGINAL)).toEqual(saved);
    expect(await notebookJSON(page)).toEqual(saved);
    expect(await page.evaluate(path => [...window.jupyterapp.shell.widgets('main')]
      .find(widget => widget.context?.path === path)?.content?.model?.dirty, ORIGINAL)).toBe(false);
    evidence.ordinarySave = { api: 'NotebookPanel.context.save', dirtyBefore: true, dirtyAfter: false, originalPath: ORIGINAL, updatedPath: path };
  });
});

test('line highlights and written cell states distinguish course, learner and conflicting edits', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    await openNotebook(page);
    let review = await beginReview(page, 'Updated instructions');
    let instructions = review.locator('[data-cell-id="instructions"]');
    let answer = review.locator('[data-cell-id="answer"]');
    await expect(instructions).toHaveAttribute('data-state', 'course');
    await expect(answer).toHaveAttribute('data-state', 'unchanged');
    await expect(answer.getByText('Unchanged', { exact: true }).first()).toBeVisible();
    expect(await renderedLines(answer.getByLabel('Your work', { exact: true }))).toEqual([
      { text: 'answer = None', change: 'unchanged' }
    ]);
    expect(await renderedLines(instructions.getByLabel('Base version', { exact: true }))).toEqual([
      { text: source(fixture(1).cells[0].source), change: 'removed' }
    ]);
    expect(await renderedLines(instructions.getByLabel('Course update', { exact: true }))).toEqual([
      { text: UPDATED_INSTRUCTIONS, change: 'added' }
    ]);
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openNotebook(page);
    await setAnswer(page, LEARNER_SOURCE);
    review = await beginReview(page, 'Updated instructions');
    answer = review.locator('[data-cell-id="answer"]');
    await expect(answer).toHaveAttribute('data-state', 'learner');
    await expect(answer.getByText('Your edit', { exact: true }).first()).toBeVisible();
    expect(await previewSource(answer)).toBe(LEARNER_SOURCE);
    await review.getByRole('combobox', { name: 'Course update version', exact: true }).selectOption({ label: 'Worked example' });
    await review.getByRole('button', { name: 'Preview update', exact: true }).click();
    answer = review.locator('[data-cell-id="answer"]');
    await expect(answer).toHaveAttribute('data-state', 'conflict');
    await expect(answer.getByText('Conflict', { exact: true }).first()).toBeVisible();
    await expect(review.getByLabel('Conflicts remaining', { exact: true })).toHaveText('1');
    await expect(review.getByRole('radio', { name: 'Keep my answer', exact: true })).not.toBeChecked();
    await expect(review.getByRole('radio', { name: 'Use course answer', exact: true })).not.toBeChecked();
    expect(await renderedLines(answer.getByLabel('Base version', { exact: true }))).toEqual([
      { text: 'answer = None', change: 'removed' }
    ]);
    expect(await renderedLines(answer.getByLabel('Your work', { exact: true }))).toEqual(LEARNER_SOURCE.split('\n').map(text => ({ text, change: 'added' })));
    expect(await renderedLines(answer.getByLabel('Course update', { exact: true }))).toEqual(INCOMING_SOURCE.split('\n').map(text => ({ text, change: 'added' })));
    await answer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/course-review-conflict-1440.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1280 });
    await review.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: 'artifacts/course-review-conflict-full.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    evidence.rendering = { sourceLinesVerified: true, cellStates: ['unchanged', 'course', 'learner', 'conflict'], nonColourLabels: true };
  });
});

test('the actual review wraps at 720 pixels without horizontal overflow', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    await page.setViewportSize({ width: 720, height: 1000 });
    await openNotebook(page);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Worked example');
    await expectNoHorizontalOverflow(page, review);
    const answer = review.locator('[data-cell-id="answer"]');
    const paneBoxes = await Promise.all(['Base version', 'Your work', 'Course update'].map(label =>
      answer.getByLabel(label, { exact: true }).boundingBox()));
    for (let index = 0; index < paneBoxes.length; index++) {
      expect(paneBoxes[index]).not.toBeNull();
      if (index > 0) {
        expect(Math.abs(paneBoxes[index].x - paneBoxes[0].x)).toBeLessThanOrEqual(1);
        expect(paneBoxes[index].y).toBeGreaterThanOrEqual(paneBoxes[index - 1].y + paneBoxes[index - 1].height);
      }
    }
    await answer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/course-review-conflict-720.png', fullPage: true });
    await review.getByRole('radio', { name: 'Keep my answer', exact: true }).check();
    expect(await previewSource(answer)).toBe(LEARNER_SOURCE);
    await expectNoHorizontalOverflow(page, review);
    await answer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/course-review-resolved-720.png', fullPage: true });
    evidence.responsive = { viewport: { width: 720, height: 1000 }, horizontalOverflow: false, panesStacked: true };
  });
});

test('keyboard radio navigation changes the resolved preview and remaining conflict count', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    await openNotebook(page);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Worked example');
    const learner = review.getByRole('radio', { name: 'Keep my answer', exact: true });
    const incoming = review.getByRole('radio', { name: 'Use course answer', exact: true });
    const answer = review.locator('[data-cell-id="answer"]');
    await learner.focus();
    await page.keyboard.press('Space');
    await expect(learner).toBeChecked();
    await expect(review.getByLabel('Conflicts remaining', { exact: true })).toHaveText('0');
    expect(await previewSource(answer)).toBe(LEARNER_SOURCE);
    await page.keyboard.press('ArrowRight');
    await expect(incoming).toBeChecked();
    await expect(learner).not.toBeChecked();
    expect(await previewSource(answer)).toBe(INCOMING_SOURCE);
    await page.keyboard.press('ArrowLeft');
    await expect(learner).toBeChecked();
    await expect(incoming).not.toBeChecked();
    expect(await previewSource(answer)).toBe(LEARNER_SOURCE);
    await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeEnabled();
    await answer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/course-review-resolved-1440.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1280 });
    await review.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: 'artifacts/course-review-resolved-full.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    evidence.keyboard = { keys: ['Space', 'ArrowRight', 'ArrowLeft'], resolvedSource: 'learner', remainingConflicts: 0 };
  });
});

test('a successful copy freezes the reviewed choices and the source shown in its receipt', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    await openNotebook(page);
    await setAnswer(page, LEARNER_SOURCE);
    const review = await beginReview(page, 'Worked example');
    await review.getByRole('radio', { name: 'Keep my answer', exact: true }).check();
    const answer = review.locator('[data-cell-id="answer"]');
    expect(await previewSource(answer)).toBe(LEARNER_SOURCE);
    const { path, run } = await copyReceipt(review);
    await expect(review.getByRole('button', { name: 'Open updated notebook', exact: true })).toBeInViewport();
    const receiptBefore = await storedJSON(page, `${run}/receipt.json`);
    const radios = review.getByRole('radio');
    await expect(radios).toHaveCount(2);
    for (let index = 0; index < await radios.count(); index++) await expect(radios.nth(index)).toBeDisabled();
    await expect(review.getByRole('radio', { name: 'Keep my answer', exact: true })).toBeChecked();
    await expect(review.getByRole('radio', { name: 'Use course answer', exact: true })).not.toBeChecked();
    await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeDisabled();
    expect(await previewSource(answer)).toBe(LEARNER_SOURCE);
    expect(receiptBefore.choices).toEqual({ answer: 'learner' });
    expect(source((await storedJSON(page, path)).cells[1].source)).toBe(LEARNER_SOURCE);
    expect(await storedJSON(page, `${run}/receipt.json`)).toEqual(receiptBefore);
    evidence.completedReview = { radiosFrozen: true, reviewedSource: 'learner', outputPath: path, receiptChoices: receiptBefore.choices };
  });
});

test('HTML-looking source remains literal text in the diff and resolved preview', async ({}, testInfo) => {
  await withBrowser(testInfo, async ({ page, evidence }) => {
    const payload = '# <img id="course-update-injected" src="/literal-html-must-not-load" onerror="window.__courseUpdateLiteralExecuted = true">\nprint("<script>window.__courseUpdateLiteralExecuted = true</script>")';
    const literalRequests = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/literal-html-must-not-load') literalRequests.push(request.url());
    });
    await openNotebook(page);
    await setAnswer(page, payload);
    const review = await beginReview(page, 'Worked example');
    const answer = review.locator('[data-cell-id="answer"]');
    const learnerLines = await renderedLines(answer.getByLabel('Your work', { exact: true }));
    expect(learnerLines.map(line => line.text).join('\n')).toBe(payload);
    await review.getByRole('radio', { name: 'Keep my answer', exact: true }).check();
    expect(await previewSource(answer)).toBe(payload);
    await expect(review.locator('#course-update-injected, script')).toHaveCount(0);
    expect(await page.evaluate(() => typeof window.__courseUpdateLiteralExecuted)).toBe('undefined');
    expect(literalRequests).toEqual([]);
    const { path } = await copyReceipt(review);
    expect(source((await storedJSON(page, path)).cells[1].source)).toBe(payload);
    await expect(review.locator('#course-update-injected, script')).toHaveCount(0);
    expect(await page.evaluate(() => typeof window.__courseUpdateLiteralExecuted)).toBe('undefined');
    expect(literalRequests).toEqual([]);
    evidence.literalSource = { preservedExactly: true, injectedElements: 0, executedEvents: false, requests: literalRequests };
  });
});
