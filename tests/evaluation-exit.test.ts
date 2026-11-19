import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('los evaluadores conservan el informe y devuelven error si falla un criterio', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'norte-evaluation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // An available model with unusable output must fail evaluation without a network dependency.
  const preload =
    'data:text/javascript,' +
    encodeURIComponent(`
    globalThis.fetch = async (url) => Response.json(
      String(url).endsWith('/api/tags')
        ? { models: [{ name: 'qwen3:4b-instruct', digest: 'controlled-model' }] }
        : { message: { content: '{"ids":[]}' } }
    );
  `);
  for (const [name, total] of [
    ['review', 32],
    ['operations', 6],
  ] as const) {
    const script = fileURLToPath(new URL('../src/evaluation/' + name + '-run.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', preload, script], {
      cwd: root,
      env: { ...process.env, CHANGELAB_MODEL: 'qwen3:4b-instruct' },
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    const directory = join(root, 'data', 'evaluations');
    const filename = readdirSync(directory).find((file) => file.startsWith(name + '-'));
    assert.ok(filename);
    const report = JSON.parse(readFileSync(join(directory, filename), 'utf8'));
    assert.equal(report.results.length, total);
    assert.ok(
      report.results.some(
        (row: { accepted: boolean; criterionPassed: boolean }) =>
          row.accepted && !row.criterionPassed,
      ),
    );
    const passed = report.results.filter(
      (row: { criterionPassed: boolean }) => row.criterionPassed,
    ).length;
    assert.ok(passed < total);
    assert.match(result.stdout, new RegExp(passed + '/' + total + ' criterios superados'));
  }
});
