import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const configured = process.env.PAGES_BASE_URL || 'http://127.0.0.1:4173/jupyterlite-course-updates/';
const BASE = new URL(configured.endsWith('/') ? configured : `${configured}/`);
const EXPECTED_PYODIDE = process.env.EXPECTED_PYODIDE_VERSION || '314.0.6';
const LEARNER_SOURCE = 'answer = sum([2, 3, 5])\nprint("learner:", answer)';
const UPDATED_INSTRUCTIONS = 'Add 2, 3, and 5. Store the result in answer and explain your method.';
const source = value => Array.isArray(value) ? value.join('') : value;

async function storedJSON(page, path) {
  return page.evaluate(async path => {
    const stored = await window.jupyterapp.serviceManager.contents.get(path, { content: true });
    return JSON.parse(typeof stored.content === 'string' ? stored.content : JSON.stringify(stored.content));
  }, path);
}

async function modelJSON(page, path) {
  return page.evaluate(path => {
    const panel = [...window.jupyterapp.shell.widgets('main')].find(widget => widget.context?.path === path);
    if (!panel?.content?.model) throw new Error(`The real notebook model is missing: ${path}`);
    return JSON.parse(panel.content.model.toString());
  }, path);
}

test('a Pages-style subpath without COI runs Pyodide through the real service-worker contents filesystem', async ({ page, context }, testInfo) => {
  const evidence = {
    schemaVersion: 1,
    kind: 'Pages-compatible subpath/no-COI browser and filesystem smoke',
    baseURL: BASE.href, externalRequests: [], console: [], passed: false,
    deployedHost: !['127.0.0.1', 'localhost', '[::1]'].includes(BASE.hostname),
    runtime: null, serviceWorker: null, kernelFilesystem: null, review: null
  };
  mkdirSync('artifacts', { recursive: true });
  let screenshotSaved = false;
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== BASE.origin && !['blob:', 'data:'].includes(url.protocol)) evidence.externalRequests.push(url.href);
  });
  // Docker --network none is the independent offline boundary. Routes alone
  // cannot intercept every request already handled by a service worker.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== BASE.origin && !['blob:', 'data:'].includes(url.protocol)) {
      if (!evidence.externalRequests.includes(url.href)) evidence.externalRequests.push(url.href);
      await route.abort('blockedbyclient');
    } else {
      await route.continue();
    }
  });
  page.on('console', message => evidence.console.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => evidence.console.push({ type: 'pageerror', text: error.message }));
  try {
    const response = await page.goto(new URL('lab/index.html', BASE).href);
    expect(response?.ok()).toBe(true);
    const headers = await response.allHeaders();
    expect(headers['cross-origin-opener-policy']).toBeUndefined();
    expect(headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(false);
    evidence.noCOI = { crossOriginIsolated: false, openerPolicy: null, embedderPolicy: null };
    await page.waitForFunction(() => Boolean(window.jupyterapp));
    await page.evaluate(async () => {
      const app = window.jupyterapp;
      await app.started;
      await app.restored;
      await app.serviceManager.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
    const serviceWorker = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return {
        scope: registration.scope,
        activeState: registration.active?.state,
        activeScriptURL: registration.active?.scriptURL,
        controllingScriptURL: navigator.serviceWorker.controller?.scriptURL,
        crossOriginIsolated: window.crossOriginIsolated
      };
    });
    expect(serviceWorker.activeState).toBe('activated');
    expect(serviceWorker.scope.startsWith(BASE.href)).toBe(true);
    expect(serviceWorker.activeScriptURL.startsWith(BASE.href)).toBe(true);
    expect(serviceWorker.controllingScriptURL).toBe(serviceWorker.activeScriptURL);
    expect(serviceWorker.crossOriginIsolated).toBe(false);
    evidence.serviceWorker = serviceWorker;

    const path = await page.evaluate(async learnerSource => {
      const app = window.jupyterapp;
      const contents = app.serviceManager.contents;
      const seed = await contents.get('lesson.ipynb', { content: true });
      const content = JSON.parse(typeof seed.content === 'string' ? seed.content : JSON.stringify(seed.content));
      const temporary = await contents.newUntitled({ type: 'directory', path: '' });
      const folder = await contents.rename(temporary.path, `pages-smoke-${crypto.randomUUID()}`);
      const path = `${folder.path}/lesson.ipynb`;
      await contents.save(path, { type: 'notebook', format: 'json', content });
      const panel = await app.commands.execute('docmanager:open', { path, factory: 'Notebook' });
      if (!panel?.context) throw new Error('The real Pages probe notebook did not open');
      await panel.context.ready;
      app.shell.activateById(panel.id);
      panel.content.model.cells.get(1).sharedModel.setSource(learnerSource);
      await panel.context.save();
      if (panel.content.model.dirty) throw new Error('The real Pages probe notebook did not save');
      return path;
    }, LEARNER_SOURCE);
    const savedOriginal = await storedJSON(page, path);
    expect(source(savedOriginal.cells[1].source)).toBe(LEARNER_SOURCE);
    await expect(page.getByRole('tabpanel', { name: 'lesson.ipynb', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(path => {
      const app = window.jupyterapp;
      const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === path);
      return Boolean(panel?.isAttached && panel.isVisible
        && app.shell.currentWidget === panel
        && app.commands.isEnabled('notebook:run-cell')
        && panel.content.widgets.length === 2);
    }, path)).toBe(true);
    await page.evaluate(async path => {
      const app = window.jupyterapp;
      const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === path);
      if (!panel?.sessionContext) throw new Error('The real Pages notebook session is missing');
      await panel.sessionContext.ready;
      if (!panel.sessionContext.session?.kernel) throw new Error('The real Pages notebook kernel is not ready');
      panel.content.deselectAll();
      panel.content.activeCellIndex = 1;
    }, path);
    evidence.execution = await page.evaluate(path => {
      const app = window.jupyterapp;
      const panel = [...app.shell.widgets('main')].find(widget => widget.context?.path === path);
      if (!panel?.content?.activeCell) throw new Error('The real Pages notebook has no active cell');
      return {
        notebookPath: panel.context.path,
        currentWidgetPath: app.shell.currentWidget?.context?.path,
        activeCellIndex: panel.content.activeCellIndex,
        activeCellId: panel.content.activeCell.model.id,
        activeCellType: panel.content.activeCell.model.type,
        activeCellSource: panel.content.activeCell.model.sharedModel.getSource(),
        selectedCellIds: panel.content.selectedCells.map(cell => cell.model.id),
        commandEnabled: app.commands.isEnabled('notebook:run-cell'),
        kernelId: panel.sessionContext.session?.kernel?.id,
        commandStatus: 'pending', commandResult: null
      };
    }, path);
    expect(evidence.execution.currentWidgetPath).toBe(path);
    expect(evidence.execution.notebookPath).toBe(path);
    expect(evidence.execution.activeCellIndex).toBe(1);
    expect(evidence.execution.activeCellId).toBe('answer');
    expect(evidence.execution.activeCellType).toBe('code');
    expect(evidence.execution.activeCellSource).toBe(LEARNER_SOURCE);
    expect(evidence.execution.selectedCellIds).toEqual(['answer']);
    expect(evidence.execution.commandEnabled).toBe(true);
    const commandResult = await page.evaluate(async path => {
      const app = window.jupyterapp;
      if (app.shell.currentWidget?.context?.path !== path || !app.commands.isEnabled('notebook:run-cell')) {
        throw new Error('The Pages notebook lost its active execution target');
      }
      return app.commands.execute('notebook:run-cell');
    }, path);
    evidence.execution.commandStatus = 'resolved';
    evidence.execution.commandResult = commandResult === undefined ? { type: 'undefined' } : commandResult;
    expect(commandResult).toBe(true);
    await expect.poll(async () => {
      const notebook = await modelJSON(page, path);
      return notebook.cells[1].outputs.filter(output => output.output_type === 'stream').map(output => source(output.text)).join('');
    }).toBe('learner: 10\n');
    const kernel = await page.evaluate(async () => {
      const panel = window.jupyterapp.shell.currentWidget;
      await panel.sessionContext.ready;
      const kernel = panel.sessionContext.session?.kernel;
      if (!kernel) throw new Error('The real Pages notebook kernel is missing');
      let stdout = '';
      const execution = kernel.requestExecute({
        code: 'import json, os, sys, pyodide\nwith open("lesson.ipynb", encoding="utf-8") as handle:\n    saved_lesson = json.load(handle)\nsaved_source = saved_lesson["cells"][1]["source"]\nif isinstance(saved_source, list):\n    saved_source = "".join(saved_source)\nprint(json.dumps({"cwd": os.getcwd(), "platform": sys.platform, "python": sys.version.split()[0], "pyodide": pyodide.__version__, "savedSource": saved_source, "answer": answer, "cellIds": [cell["id"] for cell in saved_lesson["cells"]]}))',
        store_history: false, stop_on_error: true
      });
      execution.onIOPub = message => {
        if (message.header.msg_type === 'stream') stdout += message.content.text;
      };
      const reply = await execution.done;
      if (reply.content.status !== 'ok') throw new Error(`Real kernel filesystem probe failed: ${JSON.stringify(reply.content)}`);
      return JSON.parse(stdout.trim());
    });
    expect(kernel.cwd.startsWith('/drive/')).toBe(true);
    expect(kernel.cwd).toBe(`/drive/${path.slice(0, path.lastIndexOf('/'))}`);
    expect(kernel.platform).toBe('emscripten');
    expect(kernel.pyodide).toBe(EXPECTED_PYODIDE);
    expect(kernel.python).toMatch(/^3\.14\./);
    expect(kernel.savedSource).toBe(LEARNER_SOURCE);
    expect(kernel.answer).toBe(2 + 3 + 5);
    expect(kernel.cellIds).toEqual(['instructions', 'answer']);
    evidence.runtime = { platform: kernel.platform, python: kernel.python, pyodide: kernel.pyodide };
    evidence.kernelFilesystem = { cwd: kernel.cwd, notebookPath: path, savedSource: kernel.savedSource, answer: kernel.answer, contentsReadThroughKernel: true };

    await page.getByRole('button', { name: 'Review course update', exact: true }).click();
    const review = page.locator('[data-course-update-review]:visible').last();
    await expect(review.getByRole('button', { name: 'Preview update', exact: true })).toBeEnabled();
    await review.getByRole('combobox', { name: 'Course update version', exact: true }).selectOption({ label: 'Updated instructions' });
    await review.getByRole('button', { name: 'Preview update', exact: true }).click();
    await expect(review.locator('[data-cell-id="answer"]')).toHaveAttribute('data-state', 'learner');
    await expect(review.getByRole('radio')).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeEnabled();
    await review.getByRole('button', { name: 'Create updated copy', exact: true }).click();
    await expect(review.locator('[data-output-path]')).toHaveCount(1);
    const updatedPath = await review.locator('[data-output-path]').getAttribute('data-output-path');
    const updated = await storedJSON(page, updatedPath);
    expect(source(updated.cells[0].source)).toBe(UPDATED_INSTRUCTIONS);
    expect(source(updated.cells[1].source)).toBe(LEARNER_SOURCE);
    expect(updated.cells[1].outputs.filter(output => output.output_type === 'stream').map(output => source(output.text)).join('')).toBe('learner: 10\n');
    expect(await storedJSON(page, path)).toEqual(savedOriginal);

    await review.getByRole('combobox', { name: 'Course update version', exact: true }).selectOption({ label: 'Worked example' });
    await review.getByRole('button', { name: 'Preview update', exact: true }).click();
    const answerRow = review.locator('[data-cell-id="answer"]');
    await expect(answerRow).toHaveAttribute('data-state', 'conflict');
    await expect(answerRow.getByLabel('Base version', { exact: true })).toContainText('answer = None');
    await expect(answerRow.getByLabel('Your work', { exact: true })).toContainText('learner:');
    await expect(answerRow.getByLabel('Course update', { exact: true })).toContainText('author:');
    await expect(review.getByLabel('Conflicts remaining', { exact: true })).toHaveText('1');
    await expect(review.getByRole('button', { name: 'Create updated copy', exact: true })).toBeDisabled();
    await expect(review.getByRole('radio', { name: 'Keep my answer', exact: true })).not.toBeChecked();
    await expect(review.getByRole('radio', { name: 'Use course answer', exact: true })).not.toBeChecked();
    expect(await storedJSON(page, path)).toEqual(savedOriginal);
    evidence.review = { v2OutputPath: updatedPath, v2LearnerPreserved: true, v3UnresolvedConflictPreviewed: true, originalUnchanged: true };
    expect(evidence.externalRequests).toEqual([]);
    expect(evidence.console.filter(item => item.type === 'pageerror')).toEqual([]);
    await answerRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/pages-smoke.png', fullPage: true });
    screenshotSaved = true;
    evidence.passed = true;
  } finally {
    if (!screenshotSaved && !page.isClosed()) {
      await page.screenshot({ path: 'artifacts/pages-smoke.png', fullPage: true }).catch(error => {
        evidence.screenshotError = String(error);
      });
    }
    evidence.testTitle = testInfo.title;
    writeFileSync('artifacts/pages-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  }
});
