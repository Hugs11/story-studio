import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProjectData } from '../src/store/projectModel.js';
import { buildProjectAfterZipUnpack } from '../src/store/unpackProject.js';

test('real Rust recipe reopening keeps stories playable after JS normalization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-js-'));
  try {
    const output = join(dir, 'reopened.json');
    const run = spawnSync('cargo', ['test', '--lib', 'recipe_production_js_entry_types', '--', '--nocapture'], {
      cwd: fileURLToPath(new URL('../src-tauri/', import.meta.url)),
      env: { ...process.env, STORY_STUDIO_RECIPE_JS_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.error?.message || `${run.stdout}\n${run.stderr}`);
    const results = JSON.parse(readFileSync(output, 'utf8'));
    for (const result of results) {
      const { project } = buildProjectAfterZipUnpack({
        project: normalizeProjectData({ projectType: 'pack', rootEntries: [] }),
        menuId: null, entries: result.entries, result,
      });
      const reopened = normalizeProjectData(project);
      assert.equal(reopened.rootEntries[0].type, 'story', result.projectType);
      if (result.projectType === 'pack') {
        assert.equal(reopened.rootEntries[1].type, 'menu');
        assert.equal(reopened.rootEntries[1].children[0].type, 'story');
      }
    }
    // Empty Rust menus omit children too; their explicit type must retain the folder.
    const empty = normalizeProjectData({ rootEntries: [{ type: 'menu', id: 'empty' }] });
    assert.equal(empty.rootEntries[0].type, 'menu');
    assert.deepEqual(empty.rootEntries[0].children, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
