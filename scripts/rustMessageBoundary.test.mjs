import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import registry from '../src/locales/_generated/rust-messages.json' with { type: 'json' };

// These commands never display a free-text error. Do not widen this list to
// accommodate a new UI producer; convert that producer instead.
const STRING_EXCEPTIONS = {
  read_advanced_view_state: 'View cache: advancedViewBridge swallows failures and logs once; no UI error.',
  write_advanced_view_state: 'View cache: same non-visible cache contract.',
  rename_advanced_view_state: 'View cache: same non-visible cache contract.',
  project_pack_for_simulation: 'P1 already returns encoded UserMessage through internal String services; useProjectedSimulation presents it.',
  copy_project_to_graph: 'P1 already returns encoded UserMessage; graphCopyFlow presents refusals.',
  verify_project_graph_copy: 'P1 already returns encoded UserMessage; graphCopyFlow presents refusals.',
  cancel_generate_pack: 'Infallible command (always Ok); generate-log is a UserMessage.',
};

// Mask comments and literals before finding signatures. Braces in JSON, Rust
// strings, char literals and comments must not terminate a command signature.
function maskedRust(source) {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|r(#+)"[\s\S]*?"\1|r"[^"]*"|'(?:\\.|[^'\\])'|"(?:\\[\s\S]|[^"\\])*"/g, (value) => value.replace(/[^\n]/g, ' '));
}
export function stringCommands(source) {
  const masked = maskedRust(source);
  return [...masked.matchAll(/#\[tauri::command[^\]]*\][\s\S]*?\bfn\s+(\w+)[\s\S]*?\)\s*->\s*([^\{]+)\{/g)]
    .filter((match) => /Result<[\s\S]*,\s*String\s*>/.test(match[2])).map((match) => match[1]);
}

test('les erreurs IPC affichables ne redeviennent pas Result<_, String>', async () => {
  const found = new Set();
  for (const file of await readdir(new URL('../src-tauri/src/commands/', import.meta.url))) {
    if (!file.endsWith('.rs')) continue;
    const source = await readFile(new URL(`../src-tauri/src/commands/${file}`, import.meta.url), 'utf8');
    for (const command of stringCommands(source)) {
      assert.ok(STRING_EXCEPTIONS[command], `${file}: ${command} must return UserMessage`);
      found.add(command);
    }
  }
  assert.deepEqual([...found].sort(), Object.keys(STRING_EXCEPTIONS).sort(), 'remove obsolete exceptions');
});

test('le garde détecte une régression malgré les attributs et les accolades dans une chaîne', () => {
  assert.deepEqual(stringCommands('#[tauri::command]\n#[allow(clippy::too_many_arguments)]\npub async fn visible(x: String) -> Result<String, String> { Err("{payload}".into()) }'), ['visible']);
  assert.deepEqual(stringCommands('#[tauri::command]\npub fn coded() -> Result<String, UserMessage> { Ok(String::new()) }'), []);
});

test('chaque transport statique est une enveloppe enregistrée avec ses paramètres', async () => {
  const source = await readFile(new URL('../src-tauri/src/support/user_message/codes.rs', import.meta.url), 'utf8');
  const contracts = new Map(registry.map(({ code, params }) => [code, params]));
  let checked = 0;
  for (const match of source.matchAll(/const\s+(\w+_TRANSPORT):\s*&str\s*=\s*("(?:\\.|[^"\\])*")\s*;/g)) {
    const envelope = JSON.parse(JSON.parse(match[2]));
    assert.ok(contracts.has(envelope.code), match[1]);
    for (const parameter of contracts.get(envelope.code)) assert.ok(Object.hasOwn(envelope.params, parameter), `${match[1]} missing ${parameter}`);
    checked++;
  }
  assert.ok(checked > 100, 'exercise the actual static transports');
});

test('les canaux de journaux Rust émettent des objets UserMessage', async () => {
  for (const [file, event] of [['piper', 'piper-log'], ['xtts', 'xtts-log'], ['youtube', 'youtube-log'], ['pack', 'community-pack-checker-log']]) {
    const source = await readFile(new URL(`../src-tauri/src/commands/${file}.rs`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`emit\\(\\s*"${event}",\\s*(?:crate::support::user_message::)?UserMessage::from`), event);
  }
});

function withoutTestItems(source) {
  const masked = maskedRust(source);
  const ranges = [];
  for (const match of masked.matchAll(/#\[cfg\(test\)\]/g)) {
    let end = match.index + match[0].length;
    while (end < masked.length && !'{;'.includes(masked[end])) end++;
    if (masked[end] === '{') {
      let depth = 1; end++;
      while (depth && end < masked.length) { depth += (masked[end] === '{') - (masked[end] === '}'); end++; }
    } else end++;
    ranges.push([match.index, end]);
  }
  for (const [start, end] of ranges.reverse()) source = source.slice(0, start) + ' '.repeat(end - start) + source.slice(end);
  return source;
}
async function rustFiles(url) {
  const files = [];
  for (const entry of await readdir(url, { withFileTypes: true })) {
    if (entry.name === 'tests' || entry.name.endsWith('_tests.rs') || entry.name === 'tests.rs') continue;
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
    if (entry.isDirectory()) files.push(...await rustFiles(child));
    else if (entry.name.endsWith('.rs')) files.push(child);
  }
  return files;
}

export function freeTextErrorProducers(source) {
  const patterns = [
    /\bErr\(\s*format!\(/,
    /\.map_err\(\s*(?:move\s+)?\|\s*\w+\s*\|\s*format!\(/,
    /\.ok_or\(\s*"/,
    /\bString::from\(\s*"/,
    /\bemit\(\s*"(?:\\.|[^"\\])*"\s*\)/,
    /\bemit\(\s*"(?:\\.|[^"\\])*"\s*,\s*"/,
  ];
  // Comments do not count as producers; literal bodies remain visible to the
  // guards for ok_or / String::from / emit. OsString arguments stay technical.
  const production = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  return patterns.filter((pattern) => pattern.test(production)).map(String);
}

test('la garde détecte chaque forme de producteur libre et accepte les enveloppes', () => {
  for (const source of [
    'value.map_err(|e| format!("Impossible : {e}"))',
    'value.ok_or("Introuvable")',
    'Err(String::from("Erreur affichable"))',
    'emit("Téléchargement en cours")',
    'app.emit("youtube-log", "Téléchargement en cours")',
  ]) assert.ok(freeTextErrorProducers(source).length > 0, source);
  assert.deepEqual(freeTextErrorProducers('app.emit("youtube-log", UserMessage::new(codes::YOUTUBE_DOWNLOADING));'), []);
  assert.deepEqual(freeTextErrorProducers('OsString::from("--model")'), []);
});

test('P2/P3 : les retours applicatifs ne réintroduisent pas de templates libres', async () => {
  const areas = ['services/project_files/', 'services/pack_reader/', 'services/community_pack_checker/', 'services/piper/', 'services/xtts/', 'services/comfyui/', 'services/youtube/', 'support/'];
  const files = (await Promise.all(areas.map((area) => rustFiles(new URL(`../src-tauri/src/${area}`, import.meta.url))))).flat();
  files.push(new URL('../src-tauri/src/services/podcast.rs', import.meta.url));
  const internal = new Set(['linux_webview_gestures.rs', 'fs_pack_diagnostics.rs', 'user_message.rs', 'codes.rs']);
  // Native WebKit gesture installation only logs to the developer log; FS
  // diagnostics are internal keys. Envelope implementation keeps legacy detail.
  for (const url of files) {
    if (internal.has(url.pathname.split('/').at(-1))) continue;
    const source = withoutTestItems(await readFile(url, 'utf8'));
    assert.deepEqual(freeTextErrorProducers(source), [], url.pathname);
    assert.doesNotMatch(source, /\bErr\(\s*"|\.ok_or_else\(\s*\|\|\s*"|unsupported_with_diagnostics\(\s*format!\(/, url.pathname);
    // Displayed checker technicalDetails need coded labels too, including when
    // a nested value is an encoded message rather than an external string.
    if (url.pathname.includes('/community_pack_checker/')) assert.doesNotMatch(source, /Some\(\s*format!\(\s*"[^"\n]*(?:Détecté|Attendu|corrig|fréquence|silence)/, url.pathname);
  }
});

test('P2/P3 : les builders statiques fournissent tous les paramètres du registre', async () => {
  const contracts = new Map(registry.map(({ code, params }) => [code, params]));
  const areas = ['services/project_files/', 'services/pack_reader/', 'services/community_pack_checker/', 'services/piper/', 'services/xtts/', 'services/comfyui/', 'services/youtube/', 'support/'];
  const files = (await Promise.all(areas.map((area) => rustFiles(new URL(`../src-tauri/src/${area}`, import.meta.url))))).flat();
  files.push(new URL('../src-tauri/src/services/podcast.rs', import.meta.url));
  let checked = 0;
  for (const url of files) {
    const source = withoutTestItems(await readFile(url, 'utf8'));
    for (const match of source.matchAll(/UserMessage::new\(\s*(?:crate::support::user_message::)?codes::(\w+)\s*,?\s*\)[\s\S]*?\.into_transport\(\)/g)) {
      const names = new Set([...match[0].matchAll(/\.param\(\s*"([^"]+)"/g)].map((param) => param[1]));
      for (const required of contracts.get(match[1]) ?? []) {
        assert.ok(names.has(required), `${url.pathname}: ${match[1]} missing ${required}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 600, 'exercise generated producers, including multiline param calls');
});
