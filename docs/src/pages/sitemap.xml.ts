import { getCollection } from 'astro:content';

export const prerender = true;

const site = 'https://hugs11.github.io';
const base = '/story-studio';

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function documentationUrl(id: string) {
  const route = id
    .replace(/\.(?:md|mdx)$/, '')
    .replace(/\/index$/, '')
    .replace(/^\/+|\/+$/g, '');
  const pathname = route ? `${base}/${route}/` : `${base}/`;
  return new URL(pathname, site).href;
}

export async function GET() {
  const documents = await getCollection('docs');
  const urls = new Set([new URL(`${base}/`, site).href]);

  for (const document of documents) {
    if (document.id === '404') continue;
    urls.add(documentationUrl(document.id));
  }

  const entries = [...urls]
    .sort()
    .map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`)
    .join('\n');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `${entries}\n` +
      `</urlset>\n`,
    {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
      },
    },
  );
}
