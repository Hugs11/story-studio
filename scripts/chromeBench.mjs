// Le banc de chrome : monter les surfaces de l'application dans Node, et
// vérifier que ce qu'elles annoncent est relié à quelque chose.
//
// Pourquoi il existe. La pastille du pack de la barre du haut a cessé de se
// rendre sans que rien ne le signale : `AppShell` a gardé l'ancien nom de
// propriété quand la barre du haut a changé le sien. Les 103 suites JS sont des
// modules purs — c'est un choix, et il est bon —, mais aucune ne monte d'écran,
// donc aucune ne pouvait voir ce défaut. Ce module comble exactement ce trou,
// et rien de plus : il éprouve des **branchements**, jamais des apparences.
// Aucun rendu n'est comparé pixel à pixel, aucune image de référence n'est
// déposée ; un banc d'apparence casse à chaque retouche de style et finit
// désactivé.
//
// Ce qu'il coûte au projet. Rien de neuf n'est installé : le compilateur JSX est
// celui de `rolldown`, que Vite 8 amène déjà, et `react-dom/server` accompagne
// React. `rolldown` passe seulement de dépendance transitive à dépendance
// déclarée, à la version exacte que Vite épingle — les deux doivent rester
// alignées, faute de quoi le projet en installerait deux copies. La commande de
// test ne change pas non plus : les résolutions sont posées à l'import de ce
// module, et non par un drapeau de ligne de commande, pour que
// `node --test scripts/*.test.mjs` reste la seule à connaître.
//
// Ce qu'il ne fait pas. Il n'y a pas de DOM : un clic n'est pas dispatché, et la
// sémantique de `disabled` n'est pas jouée. Le banc lit le gestionnaire posé sur
// l'élément et l'appelle. C'est suffisant pour la famille de défauts visée — un
// nom de propriété qui diverge, un gestionnaire oublié —, et c'est sa limite.
//
// **Importer ce module avant les composants à monter** : la résolution doit être
// installée avant que leur graphe ne soit chargé, comme pour `reactHookDriver`.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'rolldown/experimental';

import { closeNotebook, openNotebook } from './chromeBenchJsx.mjs';

// La fabrique d'éléments vers laquelle le JSX de `src/` est dérouté. Le nom est
// arbitraire et n'existe sur aucun registre : il n'est là que pour être
// reconnu par la résolution ci-dessous, comme `reactHookDriver` reconnaît
// `react`.
const BENCH_JSX_SOURCE = 'story-studio/chrome-bench';
const BENCH_JSX_URL = new URL('./chromeBenchJsx.mjs', import.meta.url).href;

// `src/` importe ses voisins sans extension, ce que Vite résout et Node non.
const SUFFIXES = ['.js', '.jsx', '/index.js', '/index.jsx'];

// Vite remplace `import.meta.env` à la compilation ; Node ne le connaît pas.
// Le banc monte du code de production, donc il se déclare en production.
const VITE_ENV = { DEV: false, PROD: true, MODE: 'production', SSR: false };
const VITE_ENV_GLOBAL = '__STORY_STUDIO_BENCH_ENV__';
globalThis[VITE_ENV_GLOBAL] = VITE_ENV;

function substituteViteEnv(source) {
  return source.replaceAll('import.meta.env', `globalThis.${VITE_ENV_GLOBAL}`);
}

function isProjectSource(url) {
  return url.includes('/src/') && !url.includes('/node_modules/');
}

// La seule doublure du banc, et sa frontière.
//
// `renderDeferred` enveloppe dans un `Suspense` les sous-arbres chargés
// paresseusement — l'espace de travail et le panneau du bas. Un rendu
// synchrone ne sait pas les attendre, et le banc n'a de toute façon rien à
// leur demander : ce sont des écrans d'édition, pas du chrome. La doublure les
// laisse donc de côté.
//
// Elle ne cache rien de ce qui compte ici : les éléments différés sont
// **créés** avant d'être passés à `renderDeferred`, donc le carnet garde les
// propriétés que le shell leur tend, même si personne ne les monte.
const DEFERRED_RENDER_MODULE = '/src/components/renderDeferred.jsx';
const DEFERRED_RENDER_DOUBLE = 'export function renderDeferred() { return null; }';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === `${BENCH_JSX_SOURCE}/jsx-runtime`) {
      return { url: BENCH_JSX_URL, format: 'module', shortCircuit: true };
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
      const direct = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(direct))) {
        for (const suffix of SUFFIXES) {
          const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, format: 'module', shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    // Une feuille de style importée par un composant n'a pas de sens ici, et
    // n'en aura jamais : le banc ne regarde pas les apparences.
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export default {};', shortCircuit: true };
    }
    if (url.endsWith(DEFERRED_RENDER_MODULE)) {
      return { format: 'module', source: DEFERRED_RENDER_DOUBLE, shortCircuit: true };
    }
    if (url.endsWith('.jsx')) {
      const path = fileURLToPath(url);
      const compiled = transformSync(path, substituteViteEnv(readFileSync(path, 'utf8')), {
        jsx: { runtime: 'automatic', importSource: BENCH_JSX_SOURCE },
      });
      return { format: 'module', source: compiled.code, shortCircuit: true };
    }
    if (url.endsWith('.js') && isProjectSource(url)) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      if (source.includes('import.meta.env')) {
        return { format: 'module', source: substituteViteEnv(source), shortCircuit: true };
      }
    }
    return nextLoad(url, context);
  },
});

/**
 * Monte une surface et rend ce qu'il faut pour l'interroger : le balisage
 * produit, et le carnet des éléments créés pendant ce rendu, avec leurs props.
 *
 * Les effets ne sont pas joués — `renderToStaticMarkup` n'en joue pas. C'est
 * sans conséquence ici : un branchement se pose au rendu, pas dans un effet.
 */
export function mountSurface(element) {
  openNotebook();
  try {
    const html = renderToStaticMarkup(element);
    return { html, elements: closeNotebook() };
  } catch (error) {
    closeNotebook();
    throw error;
  }
}

/** L'unique élément portant `data-toolbar-id` égal à `id`, ou `null`. */
export function commandControl(elements, id) {
  return elements.find((element) => element.props?.['data-toolbar-id'] === id) ?? null;
}

/** Les identifiants de commande effectivement peints par la surface montée. */
export function paintedCommandIds(elements) {
  return elements
    .filter((element) => element.props?.['data-toolbar-id'] !== undefined)
    .map((element) => element.props['data-toolbar-id']);
}

/** Tous les éléments portant `attribute`, dans l'ordre de création. */
export function elementsByAttribute(elements, attribute) {
  return elements.filter((element) => element.props?.[attribute] !== undefined);
}

/** L'unique élément portant `attribute` égal à `value`, ou `null`. */
export function elementByAttribute(elements, attribute, value) {
  return elements.find((element) => element.props?.[attribute] === value) ?? null;
}

/** Le premier élément dont la classe contient `className`, ou `null`. */
export function elementByClass(elements, className) {
  return elements.find((element) => {
    const painted = element.props?.className;
    return typeof painted === 'string' && painted.split(/\s+/).includes(className);
  }) ?? null;
}
