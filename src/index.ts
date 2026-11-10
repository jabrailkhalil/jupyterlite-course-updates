import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { MainAreaWidget, ToolbarButton } from '@jupyterlab/apputils';
import { PageConfig, URLExt } from '@jupyterlab/coreutils';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { DisposableDelegate } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';
import { planUpdate, resolveUpdate, fingerprint, sourceText, UpdatePlan, Choice, Notebook } from './merge.js';
import { cellState, diffLines, DiffLine } from './presentation.js';

interface Revision { version: string; label?: string; url: string; }
interface Course { schemaVersion: number; courseId: string; base: Revision; updates: Revision[]; }
interface Review { plan: UpdatePlan; model: string; disk: string; path: string; revision: Revision; course: Course; }

function readCourse(value: unknown): Course {
  const course = value as Partial<Course> | null;
  const text = (item: unknown): item is string => typeof item === 'string' && item.trim().length > 0;
  if (!course || course.schemaVersion !== 1 || !text(course.courseId) || !course.base || !Array.isArray(course.updates) || !course.updates.length) throw new Error('This course manifest is unsupported.');
  for (const revision of [course.base, ...course.updates]) {
    if (!revision || !text(revision.version) || !text(revision.url) || (revision.label !== undefined && !text(revision.label))) throw new Error('Every course version needs a version name and a notebook URL.');
  }
  if (new Set([course.base.version, ...course.updates.map(revision => revision.version)]).size !== course.updates.length + 1) throw new Error('Course versions must be distinct.');
  return course as Course;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderLines(pre: HTMLPreElement, lines: DiffLine[]): void {
  pre.replaceChildren();
  lines.forEach((line, index) => {
    const row = element('span'); row.className = 'jp-CourseUpdate-line';
    row.dataset.change = line.change; row.dataset.line = String(index + 1);
    const gutter = element('span'); gutter.className = 'jp-CourseUpdate-gutter';
    gutter.setAttribute('aria-hidden', 'true'); gutter.dataset.number = String(index + 1);
    gutter.dataset.sign = line.change === 'added' ? '+' : line.change === 'removed' ? '−' : '';
    const text = element('span', line.text); text.className = 'jp-CourseUpdate-lineText';
    row.append(gutter, text); pre.append(row);
    if (index < lines.length - 1) pre.append(document.createTextNode('\n'));
  });
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function jsonContent(content: unknown): unknown {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  if (typeof serialized !== 'string') throw new Error('The notebook has no JSON content.');
  return JSON.parse(serialized);
}
function sameOriginAsset(url: string, parent: URL): URL {
  const result = new URL(url, parent);
  if (result.origin !== window.location.origin) throw new Error('Course assets must be served with this site.');
  return result;
}
async function readAsset(url: URL): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Course asset could not be loaded (${response.status}).`);
  return response.json();
}
async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprint(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

class CourseReview extends Widget {
  private status = element('div');
  private select = element('select');
  private preview = element('button', 'Preview update');
  private apply = element('button', 'Create updated copy');
  private cancel = element('button', 'Cancel');
  private comparison = element('div');
  private receipt = element('div');
  private summary = element('div');
  private conflictCount = element('span', '0');
  private courseCount = element('span', '0');
  private learnerCount = element('span', '0');
  private versionInfo = element('span');
  private progress = element('ol');
  private review: Review | null = null;
  private choices: Record<string, Choice> = Object.create(null);
  private generation = 0;
  private busy = false;
  private course: Course | null = null;
  private manifestURL: URL;

  constructor(private app: JupyterFrontEnd, private panel: NotebookPanel) {
    super();
    this.id = `course-update-content-${crypto.randomUUID()}`;
    this.addClass('jp-CourseUpdate');
    this.node.dataset.courseUpdateReview = 'true';
    this.title.label = 'Review course update';
    this.title.closable = true;
    this.manifestURL = new URL(URLExt.join(PageConfig.getBaseUrl(), 'course-assets/course.json'), window.location.href);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.className = 'jp-CourseUpdate-status';
    this.select.setAttribute('aria-label', 'Course update version');
    this.preview.disabled = true;
    this.apply.disabled = true;
    this.comparison.className = 'jp-CourseUpdate-comparison';
    this.receipt.className = 'jp-CourseUpdate-receipt';
    const header = element('header'); header.className = 'jp-CourseUpdate-header';
    const eyebrow = element('div', 'COURSE UPDATE'); eyebrow.className = 'jp-CourseUpdate-eyebrow';
    const heading = element('h2', 'Review your course update');
    const policy = element('p', 'Review what changed, choose any conflicting answers, and save a separate copy.');
    const file = element('div'); file.className = 'jp-CourseUpdate-file';
    file.append(element('span', this.panel.context.path.split('/').pop() || 'Notebook'), this.versionInfo);
    const safe = element('span', 'Original preserved'); safe.className = 'jp-CourseUpdate-safe';
    file.append(safe); header.append(eyebrow, heading, policy, file);
    this.progress.className = 'jp-CourseUpdate-progress'; this.progress.setAttribute('aria-label', 'Update steps');
    ['Choose a version', 'Review changes', 'Create a copy'].forEach((label, index) => {
      const item = element('li'); item.dataset.step = String(index);
      item.append(element('span', String(index + 1)), document.createTextNode(label)); this.progress.append(item);
    });
    const controls = element('div'); controls.className = 'jp-CourseUpdate-controls';
    const versionLabel = element('label', 'Course version'); versionLabel.append(this.select);
    controls.append(versionLabel, this.preview);
    this.summary.className = 'jp-CourseUpdate-summary'; this.summary.hidden = true;
    this.conflictCount.setAttribute('aria-label', 'Conflicts remaining');
    for (const [count, label] of [[this.courseCount, 'Course updates'], [this.learnerCount, 'Your edits'], [this.conflictCount, 'Choices remaining']] as const) {
      const metric = element('div'); metric.append(count, element('span', label)); this.summary.append(metric);
    }
    const actions = element('footer'); actions.className = 'jp-CourseUpdate-actions';
    const prompt = element('p', 'Your original and all three reviewed versions are kept.');
    const buttons = element('div'); buttons.append(this.cancel, this.apply); actions.append(prompt, buttons);
    this.apply.className = 'jp-CourseUpdate-primary';
    this.node.append(header, this.progress, controls, this.summary, this.status, this.comparison, this.receipt, actions);
    this.preview.onclick = () => { void this.prepare(); };
    this.apply.onclick = () => { void this.createCopy(); };
    this.cancel.onclick = () => this.dispose();
    this.select.onchange = () => this.invalidate('Choose Preview update to review this version.');
    this.setPhase(0);
    void this.load();
  }

  private setPhase(phase: number): void {
    this.progress.querySelectorAll<HTMLElement>('[data-step]').forEach(item => {
      const step = Number(item.dataset.step); item.dataset.state = step < phase ? 'done' : step === phase ? 'current' : 'next';
      if (step === phase) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
  }
  private setStatus(text: string, tone = 'info'): void {
    if (!this.isDisposed) { this.status.textContent = text; this.status.dataset.tone = tone; }
  }
  private invalidate(text: string, tone = 'info'): void {
    this.generation++;
    this.review = null;
    this.choices = Object.create(null);
    this.apply.disabled = true;
    this.comparison.replaceChildren();
    this.receipt.replaceChildren();
    delete this.receipt.dataset.outputPath;
    delete this.receipt.dataset.runPath;
    this.summary.hidden = true;
    if (this.course) this.versionInfo.textContent = `Version ${this.course.base.version}`;
    this.setPhase(0);
    this.setStatus(text, tone);
  }
  private setBusy(value: boolean): void {
    this.busy = value;
    this.node.setAttribute('aria-busy', String(value));
    this.preview.disabled = value || !this.course;
    this.select.disabled = value;
    this.cancel.disabled = value;
    this.apply.disabled = value || !this.canApply();
    this.comparison.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(radio => { radio.disabled = value || !this.review; });
  }
  private canApply(): boolean {
    return !!this.review && this.review.plan.conflicts.every(c => Object.hasOwn(this.choices, c.id));
  }
  private currentModel(): unknown {
    if (this.panel.isDisposed || !this.panel.content.model) throw new Error('The original notebook was closed. Open it and review again.');
    // Lab's toJSON() includes optional undefined fields (e.g. attachments).
    // Compare serialized notebook JSON at this API boundary.
    return JSON.parse(this.panel.content.model.toString());
  }
  private async disk(path: string): Promise<unknown> {
    const model = await this.app.serviceManager.contents.get(path, { content: true });
    if (model.type !== 'notebook') throw new Error('The original path is no longer a notebook.');
    return jsonContent(model.content);
  }
  private async load(): Promise<void> {
    try {
      const course = readCourse(await readAsset(this.manifestURL));
      sameOriginAsset(course.base.url, this.manifestURL);
      if (this.isDisposed) return;
      for (const rev of course.updates) {
        sameOriginAsset(rev.url, this.manifestURL);
        const option = element('option', rev.label || rev.version); option.value = rev.version;
        this.select.append(option);
      }
      this.course = course;
      this.versionInfo.textContent = `Version ${course.base.version}`;
      this.preview.disabled = false;
      this.setStatus('Choose a course version, then preview its changes.');
    } catch (error) { this.setStatus(message(error), 'warning'); }
  }
  private async prepare(): Promise<void> {
    if (this.busy || !this.course) return;
    this.invalidate('Loading the three versions…');
    const generation = this.generation;
    this.setBusy(true);
    try {
      await this.panel.context.ready;
      const path = this.panel.context.path;
      if (!path.endsWith('.ipynb')) throw new Error('Open a notebook to review a course update.');
      const learner = this.currentModel();
      const model = fingerprint(learner);
      const revision = this.course.updates.find(r => r.version === this.select.value)!;
      const [base, incoming, disk] = await Promise.all([
        readAsset(sameOriginAsset(this.course.base.url, this.manifestURL)),
        readAsset(sameOriginAsset(revision.url, this.manifestURL)),
        this.disk(path)
      ]);
      if (this.isDisposed || generation !== this.generation) return;
      if (this.panel.context.path !== path || fingerprint(this.currentModel()) !== model) throw new Error('The notebook changed while loading. Preview the update again.');
      const plan = planUpdate(base, learner, incoming);
      this.review = { plan, model, disk: fingerprint(disk), path, revision, course: this.course };
      this.versionInfo.textContent = `Version ${this.course.base.version} → ${revision.version}`;
      this.render(plan);
      this.setPhase(1);
      this.setStatus(plan.conflicts.length ? 'Choose how to resolve each conflicting cell.' : 'No conflicting cell edits. Review the versions before creating a copy.', plan.conflicts.length ? 'warning' : 'success');
    } catch (error) { this.invalidate(message(error), 'warning'); }
    finally { if (!this.isDisposed) this.setBusy(false); }
  }
  private render(plan: UpdatePlan): void {
    this.comparison.replaceChildren();
    this.summary.hidden = false;
    this.courseCount.textContent = String(plan.changedCells.length);
    this.learnerCount.textContent = String(plan.base.cells.filter((cell, index) => sourceText(cell.source) !== sourceText(plan.learner.cells[index].source)).length);
    const legend = element('div'); legend.className = 'jp-CourseUpdate-legend';
    legend.append(element('span', '+ New or edited line'), element('span', '− Replaced base line'));
    this.comparison.append(legend);
    for (let index = 0; index < plan.base.cells.length; index++) {
      const cell = plan.base.cells[index];
      const row = element('section'); row.className = 'jp-CourseUpdate-cell'; row.dataset.cellId = cell.id;
      const conflict = plan.conflicts.find(c => c.id === cell.id);
      const base = sourceText(cell.source), learner = sourceText(plan.learner.cells[index].source), incoming = sourceText(plan.incoming.cells[index].source);
      const state = cellState(base, learner, incoming); row.dataset.state = state;
      const title = element('div'); title.className = 'jp-CourseUpdate-cellHeader';
      const heading = element('h3', cell.id === 'instructions' ? 'The exercise' : cell.id === 'answer' ? 'Your answer' : cell.id);
      const badge = element('span', { unchanged: 'Unchanged', course: 'Course update', learner: 'Your edit', conflict: 'Conflict' }[state]);
      badge.className = 'jp-CourseUpdate-badge'; badge.dataset.kind = state;
      title.append(heading, badge); row.append(title);
      const panes = element('div'); panes.className = 'jp-CourseUpdate-panes';
      const localDiff = diffLines(base, learner), remoteDiff = diffLines(base, incoming);
      const oldLines = localDiff.before.map((line, i): DiffLine => ({ text: line.text, change: line.change === 'removed' || remoteDiff.before[i].change === 'removed' ? 'removed' : 'unchanged' }));
      for (const [label, lines] of [['Base version', oldLines], ['Your work', localDiff.after], ['Course update', remoteDiff.after]] as const) {
        const pane = element('div'); pane.className = 'jp-CourseUpdate-pane'; pane.dataset.pane = label;
        pane.append(element('h4', label));
        const source = element('pre'); source.setAttribute('aria-label', label); renderLines(source, [...lines]);
        pane.append(source); panes.append(pane);
      }
      row.append(panes);
      if (conflict) {
        const group = element('fieldset'); group.append(element('legend', 'Resolve this cell'));
        for (const [choice, label] of [['learner', 'Keep my answer'], ['incoming', 'Use course answer']] as const) {
          const wrapper = element('label'); const radio = element('input');
          wrapper.className = 'jp-CourseUpdate-choice';
          radio.type = 'radio'; radio.name = `choice-${this.id}-${cell.id}`; radio.value = choice;
          radio.onchange = () => {
            if (this.busy || !this.review) return;
            this.choices[cell.id] = choice; this.refreshResults();
          };
          wrapper.append(radio, document.createTextNode(label)); group.append(wrapper);
        }
        row.append(group);
      }
      const result = element('div'); result.className = 'jp-CourseUpdate-result';
      const resultHead = element('div'); resultHead.className = 'jp-CourseUpdate-resultHeader';
      const resultStatus = element('span'); resultStatus.dataset.resultStatus = 'true';
      resultHead.append(element('h4', 'Updated copy preview'), resultStatus);
      const resultSource = element('pre'); resultSource.setAttribute('aria-label', 'Updated copy preview');
      result.append(resultHead, resultSource); row.append(result);
      this.comparison.append(row);
    }
    this.refreshResults();
  }
  private refreshResults(): void {
    if (!this.review) return;
    const plan = this.review.plan;
    const previewChoices: Record<string, Choice> = Object.create(null);
    for (const conflict of plan.conflicts) previewChoices[conflict.id] = this.choices[conflict.id] || 'learner';
    const preview = resolveUpdate(plan, previewChoices);
    const remaining = plan.conflicts.filter(conflict => !Object.hasOwn(this.choices, conflict.id)).length;
    this.conflictCount.textContent = String(remaining);
    this.summary.dataset.ready = String(remaining === 0);
    this.apply.disabled = this.busy || !this.canApply();
    if (plan.conflicts.length) this.setStatus(remaining ? 'Choose how to resolve each conflicting cell.' : 'Your choices are ready. Review the copy below, then save.', remaining ? 'warning' : 'success');
    this.comparison.querySelectorAll<HTMLElement>('[data-cell-id]').forEach((row, index) => {
      const cell = plan.learner.cells[index];
      const conflict = plan.conflicts.some(item => item.id === cell.id);
      const pending = conflict && !Object.hasOwn(this.choices, cell.id);
      const source = row.querySelector<HTMLPreElement>('pre[aria-label="Updated copy preview"]')!;
      const status = row.querySelector<HTMLElement>('[data-result-status]')!;
      row.dataset.resolution = pending ? 'pending' : conflict ? this.choices[cell.id] : 'automatic';
      row.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(radio => {
        radio.closest('label')!.dataset.selected = String(radio.checked);
      });
      if (pending) {
        source.textContent = 'Choose which answer to keep.'; source.dataset.pending = 'true'; status.textContent = 'Awaiting your choice';
      } else {
        delete source.dataset.pending;
        const local = sourceText(cell.source), selected = sourceText(preview.cells[index].source);
        renderLines(source, diffLines(local, selected).after);
        status.textContent = selected === local && row.dataset.state !== 'unchanged' ? 'Your work kept' : selected !== local ? 'Course version' : 'Unchanged';
        if (cell.cell_type === 'code' && selected !== local && (cell.outputs!.length > 0 || cell.execution_count !== null)) status.textContent += ' · Previous output cleared';
      }
    });
  }
  private async assertFresh(review: Review): Promise<void> {
    if (this.isDisposed || this.panel.context.path !== review.path || fingerprint(this.currentModel()) !== review.model) throw new Error('Your notebook changed after preview. Preview the update again.');
    const disk = await this.disk(review.path);
    if (fingerprint(disk) !== review.disk || this.panel.context.path !== review.path || fingerprint(this.currentModel()) !== review.model) throw new Error('The saved notebook changed after preview. Preview the update again.');
  }
  private async saveNotebook(path: string, notebook: Notebook, original: string): Promise<void> {
    if (path === original || path === this.panel.context.path) throw new Error('An updated copy cannot replace the original.');
    await this.app.serviceManager.contents.save(path, { type: 'notebook', format: 'json', content: notebook });
  }
  private async createCopy(): Promise<void> {
    const review = this.review;
    if (this.busy || !review || !this.canApply()) return;
    const choices = { ...this.choices };
    this.setBusy(true);
    this.setStatus('Creating the reviewed copy…');
    let ownedRun: string | null = null;
    const ownedFiles: string[] = [];
    try {
      await this.assertFresh(review);
      const updated = resolveUpdate(review.plan, choices);
      const folder = await this.app.serviceManager.contents.newUntitled({ type: 'directory', path: '' });
      ownedRun = folder.path;
      const unique = `course-update-${crypto.randomUUID()}`;
      const renamed = await this.app.serviceManager.contents.rename(folder.path, unique);
      const run = renamed.path;
      ownedRun = run;
      await this.assertFresh(review);
      for (const [name, content] of [['base', review.plan.base], ['learner', review.plan.learner], ['incoming', review.plan.incoming]] as const) {
        const path = `${run}/${name}.ipynb`;
        ownedFiles.push(path);
        await this.saveNotebook(path, content, review.path);
      }
      await this.assertFresh(review);
      const output = `${run}/updated.ipynb`;
      ownedFiles.push(output);
      await this.saveNotebook(output, updated, review.path);
      const receipts = {
        schemaVersion: 1, courseId: review.course.courseId,
        baseVersion: review.course.base.version, incomingVersion: review.revision.version,
        originalPath: review.path, outputPath: output,
        snapshots: { base: `${run}/base.ipynb`, learner: `${run}/learner.ipynb`, incoming: `${run}/incoming.ipynb` },
        hashFormat: 'SHA-256 of canonical JSON with cell source arrays joined',
        sha256: { base: await sha256(review.plan.base), learner: await sha256(review.plan.learner), incoming: await sha256(review.plan.incoming), updated: await sha256(updated) },
        choices, createdAt: new Date().toISOString(), policy: 'reviewed-copy; original preserved; no cross-tab atomicity claim'
      };
      const receiptPath = `${run}/receipt.json`;
      if (receiptPath === this.panel.context.path) throw new Error('The original notebook moved during copy creation. Preview again.');
      ownedFiles.push(receiptPath);
      await this.app.serviceManager.contents.save(receiptPath, { type: 'file', format: 'text', content: JSON.stringify(receipts, null, 2) });
      // Writes use the new directory; this is not an atomic cross-tab transaction.
      // Refuse success and clean up owned files on an observable original change.
      await this.assertFresh(review);
      if (this.isDisposed) return;
      this.receipt.dataset.outputPath = output;
      this.receipt.dataset.runPath = run;
      const open = element('button', 'Open updated notebook');
      open.className = 'jp-CourseUpdate-primary';
      open.onclick = () => { void this.app.commands.execute('docmanager:open', { path: output, factory: 'Notebook' }); };
      const details = element('details'); details.append(element('summary', 'Saved versions & details'), element('code', output), element('p', 'Base, your work and the course update are saved alongside the new notebook.'));
      this.receipt.replaceChildren(element('h3', 'Your updated notebook is ready'), element('p', 'Open the new copy to continue. Your original stays where it was.'), open, details);
      this.setStatus('Updated copy is ready. Your original notebook is unchanged.', 'success');
      this.setPhase(2);
      this.review = null;
      if (this.node.getClientRects().length) {
        this.receipt.scrollIntoView({ block: 'nearest' });
        if (this.node.contains(document.activeElement) || document.activeElement === document.body) open.focus({ preventScroll: true });
      }
    } catch (error) {
      let cleanup = '';
      if (ownedRun) {
        try {
          const contents = this.app.serviceManager.contents;
          const directory = await contents.get(ownedRun, { content: true });
          const present = new Set<string>(Array.isArray(directory.content) ? directory.content.map((file: { path: string }) => file.path) : []);
          for (const path of ownedFiles.reverse()) {
            // Delete only files this operation created, never a moved original.
            if (path === this.panel.context.path || !present.has(path)) continue;
            await contents.delete(path);
          }
          const remaining = await contents.get(ownedRun, { content: true });
          if (Array.isArray(remaining.content) && remaining.content.length === 0) {
            await contents.delete(ownedRun);
          } else {
            cleanup = ` The copy is incomplete. Directory ${ownedRun} was kept because it contains the moved original or other files.`;
          }
        } catch (cleanupError) {
          cleanup = ` Incomplete copy at ${ownedRun} could not be removed: ${message(cleanupError)}. Do not use it; preview again.`;
        }
      }
      this.invalidate(message(error) + cleanup, 'warning');
    } finally { if (!this.isDisposed) this.setBusy(false); }
  }
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: '@jabrailkhalil/course-update-lab:plugin',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    let serial = 0;
    const openReview = (panel: NotebookPanel) => {
      const content = new CourseReview(app, panel);
      const widget = new MainAreaWidget({ content });
      widget.id = `course-update-review-${++serial}`;
      widget.title.label = 'Review course update'; widget.title.closable = true;
      app.shell.add(widget, 'main'); app.shell.activateById(widget.id);
    };
    app.commands.addCommand('course-update-lab:review', {
      label: 'Review course update',
      isEnabled: () => !!tracker.currentWidget,
      execute: () => { if (tracker.currentWidget) openReview(tracker.currentWidget); }
    });
    app.docRegistry.addWidgetExtension('Notebook', {
      createNew: (panel: NotebookPanel) => {
        const button = new ToolbarButton({ label: 'Review course update', tooltip: 'Review course update', onClick: () => openReview(panel) });
        panel.toolbar.insertItem(1, 'course-update-lab', button);
        return new DisposableDelegate(() => button.dispose());
      }
    });
  }
};
export default plugin;
