import process from 'node:process';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PurgeCSS } from 'purgecss';

const CONTENT_GLOBS = [
  'index.html',
  'src/**/*.{js,jsx}',
];

const CSS_GLOBS = [
  'src/**/*.css',
];

// PurgeCSS ne peut pas reconstruire les valeurs interpolées des template
// strings. Ces familles sont générées à partir d'états, types ou identifiants
// métier bornés dans le code. Elles restent hors des candidats automatiques et
// doivent être vérifiées par couverture runtime.
const DYNAMIC_CLASS_PATTERNS = [
  /^is-/,
  /^has-/,
  /data-theme/,
  /^bottom-workspace-tab--/,
  /^checker-(?:group|measure|mini-severity|report-verdict|summary-tile)--/,
  /^dialog-panel--/,
  /^fd-complete-canvas--/,
  /^fd-complete-node--/,
  /^fd-complete-line--/,
  /^fd-complete-edge-label--/,
  /^fd-complete-sibling-group--/,
  /^fd-level-band--/,
  /^funnel-modal--/,
  /^funnel-tool-btn--/,
  /^badge-nav--/,
  /^mode-proj-dot--tone-/,
  /^origin-/,
  /^sd-(?:usage|job|badge)-/,
  /^rq-(?:job|badge)-/,
  /^structure-actions-bar--/,
  /^tree-item--/,
];

function normalizePath(file) {
  return file.replaceAll('\\', '/');
}

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(file));
    } else if (entry.isFile() && (file.endsWith('.js') || file.endsWith('.jsx'))) {
      files.push(file);
    }
  }

  return files;
}

async function findOrphanCssFiles(cssFiles) {
  const importedCss = new Set();
  const sourceFiles = await collectSourceFiles('src');
  const importPattern = /\bimport\s+['"]([^'"]+\.css)['"]/g;

  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      importedCss.add(pathKey(path.resolve(path.dirname(sourceFile), match[1])));
    }
  }

  return cssFiles
    .filter((file) => !importedCss.has(pathKey(file)))
    .map(normalizePath)
    .sort(compareText);
}

export async function auditUnusedCss() {
  const results = await new PurgeCSS().purge({
    content: CONTENT_GLOBS,
    css: CSS_GLOBS,
    rejected: true,
    safelist: {
      greedy: DYNAMIC_CLASS_PATTERNS,
    },
  });

  const files = results
    .map((result) => ({
      file: normalizePath(result.file),
      selectors: [...new Set(
        (result.rejected ?? []).map((selector) => selector.trim()).filter(Boolean),
      )].sort(compareText),
    }))
    .sort((left, right) => compareText(left.file, right.file));

  return {
    files,
    orphanFiles: await findOrphanCssFiles(files.map((result) => result.file)),
  };
}

export function formatAuditReport({ files, orphanFiles = [] }) {
  const filesWithCandidates = files.filter((result) => result.selectors.length > 0);
  const selectorCount = filesWithCandidates.reduce(
    (total, result) => total + result.selectors.length,
    0,
  );
  const candidateFileLabel = filesWithCandidates.length === 1 ? 'file' : 'files';
  const orphanFileLabel = orphanFiles.length === 1 ? 'orphan file' : 'orphan files';

  const lines = [
    `CSS audit: ${files.length} files, ${selectorCount} candidate selectors in ${filesWithCandidates.length} ${candidateFileLabel}, ${orphanFiles.length} ${orphanFileLabel}.`,
    'Candidates are advisory only: confirm source usage and runtime coverage before deletion.',
  ];

  if (orphanFiles.length > 0) {
    lines.push('', 'Orphan CSS files:');
    lines.push(...orphanFiles.map((file) => `  ${file}`));
  }

  for (const result of filesWithCandidates) {
    lines.push('', result.file);
    lines.push(...result.selectors.map((selector) => `  ${selector}`));
  }

  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const audit = await auditUnusedCss();
  console.log(formatAuditReport(audit));
}
