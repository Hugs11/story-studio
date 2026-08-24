import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(projectDirectory, 'dist');
const basePath = '/story-studio';
const publicOrigin = 'https://hugs11.github.io';
const errors = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolutePath)));
    else files.push(absolutePath);
  }

  return files;
}

function requireFile(relativePath, label = relativePath) {
  if (!existsSync(path.join(outputDirectory, relativePath))) {
    errors.push(`${label} absent (${relativePath})`);
  }
}

function outputTargetForUrl(rawUrl, htmlRelativePath) {
  if (
    !rawUrl ||
    rawUrl.startsWith('#') ||
    rawUrl.startsWith('//') ||
    /^(?:data|mailto|tel|javascript):/i.test(rawUrl)
  ) {
    return null;
  }

  let url;
  try {
    url = new URL(rawUrl, `${publicOrigin}${basePath}/${htmlRelativePath}`);
  } catch {
    errors.push(`URL invalide dans ${htmlRelativePath}: ${rawUrl}`);
    return null;
  }

  if (url.origin !== publicOrigin || rawUrl === `${publicOrigin}/`) return null;
  if (url.pathname === basePath) url.pathname = `${basePath}/`;
  if (!url.pathname.startsWith(`${basePath}/`)) {
    errors.push(`lien interne hors base path dans ${htmlRelativePath}: ${rawUrl}`);
    return null;
  }

  if (/\.mdx?$/i.test(url.pathname)) {
    errors.push(`lien interne vers une source Markdown dans ${htmlRelativePath}: ${rawUrl}`);
  }

  const relativePath = decodeURIComponent(url.pathname.slice(basePath.length + 1));
  return relativePath || 'index.html';
}

function targetExists(relativePath) {
  const directTarget = path.join(outputDirectory, relativePath);
  if (existsSync(directTarget) && statSync(directTarget).isFile()) return true;
  if (existsSync(path.join(directTarget, 'index.html'))) return true;
  if (!path.extname(directTarget) && existsSync(`${directTarget}.html`)) return true;
  const withoutTrailingSeparator = directTarget.replace(/[\\/]+$/, '');
  if (
    withoutTrailingSeparator !== directTarget &&
    !path.extname(withoutTrailingSeparator) &&
    existsSync(`${withoutTrailingSeparator}.html`)
  ) {
    return true;
  }
  return false;
}

function assetUrls(html) {
  const urls = [];
  const attributePattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  const srcsetPattern = /\bsrcset=["']([^"']+)["']/gi;

  for (const match of html.matchAll(attributePattern)) urls.push(match[1]);
  for (const match of html.matchAll(srcsetPattern)) {
    for (const candidate of match[1].split(',')) {
      const [url] = candidate.trim().split(/\s+/, 1);
      if (url) urls.push(url);
    }
  }
  return urls;
}

if (!existsSync(outputDirectory)) {
  console.error('Site non construit : exécutez npm run build avant npm run check:site.');
  process.exit(1);
}

requireFile('index.html', 'landing');
requireFile('docs/index.html', 'redirection vers le concept');
requireFile('robots.txt');
requireFile('sitemap.xml');

const documentationRedirect = await readFile(
  path.join(outputDirectory, 'docs/index.html'),
  'utf8',
);
if (!documentationRedirect.includes(`${basePath}/docs/concept/`)) {
  errors.push('la route /docs/ ne redirige pas vers /docs/concept/');
}

const requiredDocumentationRoutes = [
  'docs/concept/index.html',
  'docs/editeur-libre/index.html',
  'docs/editeur-simplifie/index.html',
  'docs/modifier-un-pack-existant/index.html',
  'docs/creer-un-pack-depuis-un-podcast/index.html',
  'docs/creer-un-pack-depuis-youtube/index.html',
  'docs/agreger-des-packs/index.html',
  'docs/verifier-un-pack/index.html',
  'docs/ouvrir-un-projet/index.html',
  'docs/menu-racine/index.html',
  'docs/dossier/index.html',
  'docs/histoire/index.html',
  'docs/message-de-fin/index.html',
  'docs/exemples-de-structures/index.html',
  'docs/navigation/index.html',
  'docs/espace-d-edition/index.html',
  'docs/gestionnaire-de-medias/index.html',
  'docs/preparer-les-images/index.html',
  'docs/enregistrer-un-audio/index.html',
  'docs/editeur-audio/index.html',
  'docs/decouper-un-audio/index.html',
  'docs/assembler-des-audios/index.html',
  'docs/workspace-et-fichiers-de-projet/index.html',
  'docs/sessions-temporaires-et-recuperation/index.html',
  'docs/importer-et-extraire-un-pack/index.html',
  'docs/preparer-et-exporter/index.html',
  'docs/projet-mbah-ou-extraction-zip/index.html',
  'docs/voix-locales-piper-xtts/index.html',
  'docs/comfyui/index.html',
  'docs/preferences-et-raccourcis/index.html',
  'docs/resoudre-un-blocage-generation/index.html',
];

const preservedGuidePaths = [
  'guides/xtts-setup.fr.md',
  'guides/xtts-setup-linux.fr.md',
  'guides/comfyui-setup.fr.md',
  'guides/xtts-setup.md',
  'guides/xtts-setup-linux.md',
  'guides/comfyui-setup.md',
];

for (const route of requiredDocumentationRoutes) requireFile(route, `page documentaire ${route}`);
for (const guide of preservedGuidePaths) requireFile(guide, `ancien guide préservé ${guide}`);

const files = await walk(outputDirectory);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const pagefindFiles = files.filter((file) => file.includes(`${path.sep}pagefind${path.sep}`));

if (!pagefindFiles.some((file) => path.basename(file) === 'pagefind.js')) {
  errors.push('bundle Pagefind absent');
}

for (const htmlFile of htmlFiles) {
  const relativeHtmlPath = path.relative(outputDirectory, htmlFile).split(path.sep).join('/');
  const html = await readFile(htmlFile, 'utf8');
  const documentsLocalIntegration = [
    'docs/comfyui/index.html',
    'docs/voix-locales-piper-xtts/index.html',
  ].includes(relativeHtmlPath);

  if (
    /file:\/\/|\/(?:home|Users)\/|[A-Za-z]:\\/i.test(html) ||
    (!documentsLocalIntegration && /\blocalhost\b/i.test(html))
  ) {
    errors.push(`chemin local ou localhost détecté dans ${relativeHtmlPath}`);
  }
  if (/page à venir|contenu à venir|coming soon|lorem ipsum|\bTODO\b/i.test(html)) {
    errors.push(`contenu placeholder détecté dans ${relativeHtmlPath}`);
  }

  for (const rawUrl of assetUrls(html)) {
    const target = outputTargetForUrl(rawUrl, relativeHtmlPath);
    if (target && !targetExists(target)) {
      errors.push(`cible interne absente depuis ${relativeHtmlPath}: ${rawUrl}`);
    }
  }
}

const sitemap = await readFile(path.join(outputDirectory, 'sitemap.xml'), 'utf8');
const sitemapUrls = htmlFiles
  .map((file) => path.relative(outputDirectory, file).split(path.sep).join('/'))
  .filter((relativePath) => !['404.html', 'docs/index.html'].includes(relativePath))
  .map((relativePath) => {
    const route = relativePath.replace(/index\.html$/, '').replace(/\.html$/, '/');
    return `${publicOrigin}${basePath}/${route}`;
  });

for (const requiredUrl of sitemapUrls) {
  if (!sitemap.includes(`<loc>${requiredUrl}</loc>`)) {
    errors.push(`URL absente du sitemap: ${requiredUrl}`);
  }
}

if (errors.length > 0) {
  console.error(`Audit du site en échec (${errors.length} erreur${errors.length > 1 ? 's' : ''}) :`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Audit du site réussi : ${htmlFiles.length} pages HTML, ${pagefindFiles.length} fichiers Pagefind.`,
);
