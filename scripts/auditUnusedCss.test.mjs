import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAuditReport } from './audit-unused-css.mjs';

test('formatAuditReport groups candidates and ignores empty files', () => {
  const report = formatAuditReport({
    files: [
      { file: 'src/a.css', selectors: ['.dead-a', '.dead-b'] },
      { file: 'src/b.css', selectors: [] },
    ],
    orphanFiles: ['src/orphan.css'],
  });

  assert.match(report, /2 files, 2 candidate selectors in 1 file, 1 orphan file/);
  assert.match(report, /src\/a\.css/);
  assert.match(report, /src\/orphan\.css/);
  assert.match(report, /\.dead-a/);
  assert.doesNotMatch(report, /src\/b\.css/);
});
