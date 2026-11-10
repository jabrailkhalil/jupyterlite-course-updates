import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This script deliberately breaks compiled code. Never run it on the user's PC.
if (process.env.CI !== 'true') {
  throw new Error('Negative controls are allowed only in remote CI with CI=true.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = join(root, 'lib', 'merge.js');
const artifacts = join(root, 'artifacts');
const testFile = 'tests/merge.test.mjs';
const original = readFileSync(compiled);
const source = original.toString('utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each exact, unique anchor changes one behavior independently. These are
// synthetic faulty variants, not historical production defects or browser runs.
const controls = [
  {
    id: 'incoming-overwrites-learner',
    test: 'separate author and learner cells merge without losing the answer or output',
    anchor: 'let selected = local;',
    replacement: 'let selected = remote;'
  },
  {
    id: 'same-cell-conflict-hidden',
    test: 'different edits to the same cell require an explicit choice',
    anchor: 'if (local !== original && remote !== original && local !== remote) {',
    replacement: 'if (false && local !== original && remote !== original && local !== remote) {'
  },
  {
    id: 'stale-code-outputs-retained',
    test: 'choosing incoming code clears stale outputs, execution count and trust',
    anchor: 'cell.outputs = [];',
    replacement: 'void cell.outputs;'
  }
];

const results = [];
let infrastructureError = null;
let restored = false;
mkdirSync(artifacts, { recursive: true });

function restore() {
  writeFileSync(compiled, original);
  if (!readFileSync(compiled).equals(original)) {
    throw new Error('The original compiled merge engine could not be restored.');
  }
}

try {
  for (const control of controls) {
    const occurrences = source.split(control.anchor).length - 1;
    if (occurrences !== 1) {
      results.push({
        id: control.id,
        test: control.test,
        passed: false,
        error: `Expected one exact mutation anchor; found ${occurrences}.`,
        executed: false
      });
      continue;
    }

    const args = [
      '--test',
      '--test-reporter=tap',
      `--test-name-pattern=^${escapeRegex(control.test)}$`,
      testFile
    ];
    try {
      writeFileSync(compiled, source.replace(control.anchor, control.replacement));
      const child = spawnSync(process.execPath, args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024
      });
      const stdout = child.stdout ?? '';
      const stderr = child.stderr ?? '';
      const output = `${stdout}\n${stderr}`;
      const tapFile = `artifacts/unit-negative-${control.id}.tap`;
      const stderrFile = `artifacts/unit-negative-${control.id}.stderr.txt`;
      writeFileSync(join(root, tapFile), stdout);
      writeFileSync(join(root, stderrFile), stderr);

      const namedFailure = new RegExp(
        `^not ok \\d+ - ${escapeRegex(control.test)}\\r?$`, 'm'
      ).test(stdout);
      const assertionFailure = /\bcode:\s*['"]?ERR_ASSERTION['"]?/.test(output);
      const oneFailure = /^# fail 1\r?$/m.test(stdout);
      const noPasses = /^# pass 0\r?$/m.test(stdout);
      const setupError = /\b(?:SyntaxError|ReferenceError|TypeError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_INVALID_PACKAGE_CONFIG|ENOENT|EACCES)\b/.test(output);
      const passed = !child.error && child.signal === null && child.status === 1 &&
        namedFailure && assertionFailure && oneFailure && noPasses && !setupError;
      results.push({
        id: control.id,
        test: control.test,
        command: [process.execPath, ...args],
        executed: !child.error,
        exitCode: child.status,
        signal: child.signal,
        assertionFailure,
        namedFailure,
        oneFailure,
        noPasses,
        setupError,
        passed,
        error: child.error ? String(child.error) : null,
        tapFile,
        stderrFile
      });
    } finally {
      restore();
    }
  }
} catch (error) {
  infrastructureError = String(error);
} finally {
  try {
    restore();
    restored = true;
  } catch (error) {
    infrastructureError = [infrastructureError, String(error)].filter(Boolean).join('\n');
  }
  const passed = restored && !infrastructureError && results.length === controls.length &&
    results.every(result => result.passed);
  writeFileSync(join(artifacts, 'unit-negative-controls.json'), JSON.stringify({
    schemaVersion: 1,
    evidence: 'Synthetic unit negative controls on isolated compiled-code mutations; no browser or kernel execution.',
    originalCompiledSha256: sha256(original),
    restoredCompiledSha256: restored ? sha256(readFileSync(compiled)) : null,
    restored,
    infrastructureError,
    passed,
    controls: results
  }, null, 2) + '\n');
  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id}`);
  }
  console.log('Evidence: artifacts/unit-negative-controls.json');
  if (!passed) process.exitCode = 1;
}
