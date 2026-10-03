// Point d'entrée : `node e2e/run.mjs <parcours> [arguments]`.
// Chaque parcours vit dans `parcours/<nom>.mjs` et exporte `run(args)`.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const available = readdirSync(join(here, 'parcours')).filter(name => name.endsWith('.mjs')).map(name => name.slice(0, -4));
const [name, ...args] = process.argv.slice(2);

if (!name || !available.includes(name)) {
  console.log(`Usage : node e2e/run.mjs <parcours> [arguments]\nParcours : ${available.join(', ')}`);
  process.exit(name ? 1 : 0);
}

const module = await import(pathToFileURL(join(here, 'parcours', `${name}.mjs`)).href);
const result = await module.run(args);
process.exit(result?.passed === false ? 1 : 0);
