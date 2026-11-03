# Translating Story Studio

This guide explains how the interface text is organized, how to fix or improve a
translation, and how to add a new language. You do not need to know React or
Rust to fix a translation: you only edit JSON files.

## Overview

- French is the **source language**. Every other language is translated from it.
- English (`en`) and Italian (`it`) are offered to users. Their translations were produced with AI and reviewed in a second AI pass; human corrections are welcome.
- Which languages users see is controlled by two lists in
  `src/i18n/language.js`:
  - `PUBLIC_LANGUAGES`: the languages offered in released builds: `fr`, `en`
    and `it`.
  - `DEV_LANGUAGES`: `fr`, `en`, `it` and `pseudo`, offered in development
    builds only.
- A language moves to `PUBLIC_LANGUAGES` only when its catalogues are complete
  and reviewed (including automated review). Maintainers make that change.

### Trying a language in development

1. Install the prerequisites listed in [CONTRIBUTING.md](CONTRIBUTING.md).
2. Run `npm run tauri:dev`.
3. Open **Preferences**, section **Interface**, and use the **Interface
   language** selector. The change applies immediately and is remembered.

The selector lists `Pseudo-locale` in development builds. It is a fake language
built from the French text: vowels get accents, a `~` tail makes every string
about 35% longer, and `{{params}}` and `<tags>` are left untouched. Use it to
spot text that bypasses the catalogues (it shows as plain French, without the
accents and `~` tail) and layouts that break with longer text. The
pseudo-locale exists only in development builds and is never saved as your
preference.

## Where the text lives

All visible text is in `src/locales/`:

```text
src/locales/
  fr/<namespace>.json        source text
  en/<namespace>.json        English
  it/<namespace>.json        Italian
  _meta/<namespace>.json     context and status of every key
  _generated/rust-messages.json   list of Rust message codes (generated)
```

A namespace is a file name, one per area of the application:

| Namespace | Content |
|---|---|
| `common` | Shared interface and window shell |
| `home` | Home page and guided flows |
| `tree` | Menu editor, tree and diagram |
| `graph` | Graph editor |
| `media` | Media explorer |
| `import` | Imports |
| `ai` | Voices and image generation |
| `production` | Production and export |
| `checker` | Audiobook checker and reports |
| `settings` | Preferences |
| `help` | Help and shortcuts |
| `examples` | Example audiobooks |
| `rust` | Messages produced by the Rust engine |
| `native` | Text given to native file dialogs |

Catalogues are flat: a key is one string with dots in it, and the namespace is
not part of the key. In code the key is written `t('settings:interface.language.label')`.

```json
// src/locales/fr/settings.json
"interface.language.label": "Langue de l’interface",
// src/locales/en/settings.json
"interface.language.label": "Interface language",
// src/locales/it/settings.json
"interface.language.label": "Lingua dell’interfaccia",
```

### The `_meta` files

`src/locales/_meta/<namespace>.json` has one entry per French key. It tells the
translator where the text appears and records the state of each translation:

```json
"interface.language.label": {
  "context": "Préférences > Interface ; source « Langue de l’interface ».",
  "en": { "sourceHash": "3e91b633157d", "status": "ai-reviewed" },
  "it": { "sourceHash": "3e91b633157d", "status": "ai-reviewed" }
}
```

- `context` (required): where the string is displayed, what it means, and any
  constraint. Read it before translating. The context is written in French.
- `maxLength` (optional): the maximum length of the translation, counted in
  graphemes (user-perceived characters), ignoring `{{params}}` and `<tags>`.
  Going over it produces a warning, not an error. Rephrase instead of
  abbreviating.
- `sourceHash`: the first 12 hexadecimal characters of the SHA-256 of the French
  text (Unicode NFC, `\n` line endings). It records which French text the
  translation was made from.
- `status`: the review state of the translation (see below).

### Rust messages

Errors and progress lines produced by the Rust engine are not French strings.
Rust sends a **code** and named parameters, and the interface looks the code up
in the `rust` namespace:

```json
// src/locales/en/rust.json
"ACTION_STILL_TARGETED_one": "{{count}} transition still points to this choice list. Explicitly choose whether to remove it or redirect it.",
```

- The codes are declared in `src-tauri/src/support/user_message/codes.rs`.
- `src/locales/_generated/rust-messages.json` lists every code with its
  parameter names. A Rust test keeps it in sync; the i18n checker reads it to
  make sure each language has every code and the same parameters.
- A translator only edits `src/locales/<lang>/rust.json` and
  `src/locales/_meta/rust.json`. Do not touch the Rust sources or the generated
  file.

### What you may change, and what you never change

You may change:

- the value (the text) of a key in your language's catalogue;
- the `status` of that key in `_meta` (see below).

You never change:

- **Keys**, in any language. A key rename needs a code change.
- **Parameters** such as `{{count}}`, `{{name}}`. Keep the exact name; you can
  move it inside the sentence.
- **Tags** such as `<strong>…</strong>`, `<kbd>…</kbd>`, `<link>…</link>`. They
  are replaced by real components. Keep the same tags, with the same names.
- **Rust codes** (`ACTION_NOT_EMPTY`, …) and the generated registry.
- **The French catalogue** and the French `context` text, unless the
  maintainers agreed to the change. A change to the French text makes every
  translation of that key outdated (see `stale`).
- **Author data and technical names** (see Rules).

## Fixing a translation

1. Find the string. Search the text in `src/locales/<lang>/`, or search the
   French text in `src/locales/fr/` to get the key.
2. Read the `context` of the key in `src/locales/_meta/<namespace>.json`.
3. Edit the value in `src/locales/<lang>/<namespace>.json`. Do not touch the key.
4. In `_meta`, set `status` to `"human"` for your language. **Keep the existing
   `sourceHash`** as long as the French text did not change.
5. Run `npm run check:i18n`.

### Statuses

| Status | Meaning |
|---|---|
| `ai` | Produced by machine translation and not reviewed. |
| `ai-reviewed` | Machine translation that a second automated pass reviewed. |
| `human` | Written or checked by a person. Never replace it with machine translation. |
| `stale` | The French text changed after the translation was made. |

Only these four values are accepted.

### A `stale` key

`npm run check:i18n` reports an error when a translation is `stale` or when its
`sourceHash` no longer matches the French text. To fix it:

1. Read the new French text and the old translation.
2. Update the translation if the meaning changed. Leave it if it is still
   correct.
3. Compute the new hash of the French text:

   ```sh
   node --input-type=module -e "import { sourceHash } from './scripts/check-i18n.mjs'; console.log(sourceHash(process.argv[1]))" -- "Langue de l’interface"
   ```

   Pass the exact French value from `src/locales/fr/<namespace>.json`.
4. Put that hash in `sourceHash` and set `status` to `human`.

## Rules

### Plurals

Plural forms follow the CLDR rules through `Intl.PluralRules`. A pluralized
string has one key per category, with the suffix `_one`, `_many` or `_other`, and
the code passes a numeric `count`:

| Language | Required categories |
|---|---|
| French (`fr`) | `_one`, `_many`, `_other` |
| Italian (`it`) | `_one`, `_many`, `_other` |
| English (`en`) | `_one`, `_other` |

```json
// src/locales/it/tree.json
"count.items.label_one": "{{count}} elemento",
"count.items.label_many": "{{count}} elementi",
"count.items.label_other": "{{count}} elementi",
```

The checker requires every category `Intl.PluralRules` returns for the
language. `_many` is often the same text as `_other`: write it anyway.

### Parameters and tags

- The set of `{{…}}` names must be identical to the French text. A missing,
  renamed or extra parameter is an error.
- The set of tags must be identical to the French text. Positional tags such as
  `<0>` are forbidden.
- Never build a sentence by joining translated fragments. If a sentence needs a
  value, the French key has a parameter for it.

```json
// fr/checker.json
"summary.split.fix": "<strong>{{value}}</strong> à corriger",
// it/checker.json  (same parameter, same tag)
"summary.split.fix": "<strong>{{value}}</strong> da sistemare",
```

### Identical words ("neutral" keys)

For most namespaces, a translation that is **identical to the French text** is
an error: it usually means the key was not translated. Some strings are the same
in every language (an `OK` button, a file format, a language's own name, a
punctuation template). Those keys are declared as neutral in constants of
`scripts/check-i18n.mjs` (for example `HELP_NEUTRAL_KEYS`, `GRAPH_NEUTRAL_KEYS`,
`SETTINGS_NEUTRAL_KEYS`).

Do not invent a different translation to get around the check. If a string is
legitimately identical in your language, add its key to the matching list and
explain why in the pull request.

### Data that is never translated

- Names and titles written by authors, and the content of imported audiobooks.
- File and folder names, such as `voix-générées/` in:

  ```json
  "voice.output.help": "The file will be saved in <strong>voix-générées/</strong> in the workspace folder."
  ```

- Brand and product names: Story Studio, Lunii, STUdio, Piper, XTTS, ComfyUI,
  YouTube, yt-dlp.
- Technical identifiers and codes shown as is.
- Text that Story Studio writes into saved projects (French stage prefixes,
  default names): it is not in the catalogues and must not be localized.

## Terminology and tone

Use the same word for the same concept everywhere. Never use a synonym to vary
the style.

### Lunii hardware

| French | English | Italian |
|---|---|---|
| la Lunii (the device) | your Lunii | la Lunii, la tua Lunii |
| bouton Accueil | Home button | tasto Home |
| bouton OK | OK button | tasto OK |
| molette (de sélection) | wheel, selection wheel | rotella, rotella di selezione |
| molette de volume | volume wheel | rotella del volume |
| Mode nuit | Night mode | Modalità notte |
| menu principal (of the Lunii) | main menu | menu principale |

For a physical button, write "press" / "premi", never "click" / "clicca". In
Italian, `tasto` is a physical button on the Lunii and `pulsante` is a button on
screen.

### Story Studio concepts

| French | English | Italian |
|---|---|---|
| pack | audiobook | audiolibro |
| pack communautaire | community audiobook | audiolibro della community |
| Écran (capital letter) | Screen (capital letter) | Schermata (capital letter) |
| Écran d’entrée | Start Screen | Schermata iniziale |
| badge Racine / Entrée (graph) | Start | Inizio |
| Menu racine | Top menu | Menu iniziale |
| Histoire | Story | Storia |
| Dossier | Folder | Cartella |
| Message de fin | End message | Messaggio finale |
| Lien | Link | Collegamento |
| liste de choix | choice list | lista di scelte |
| choix | choice | scelta |
| Suite du parcours | What comes next | Cosa succede dopo |
| raccord / Raccorder | connection / Connect | connessione / Collega |
| parcours | path | percorso |
| Lecture automatique | Autoplay | Riproduzione automatica |
| Auto-next | Auto-advance | Avanzamento automatico |
| Titre audio | Spoken title | Titolo parlato |
| image-titre | title card | immagine con il titolo |
| Image / Audio de couverture | Cover image / Cover audio | Immagine / Audio di copertina |
| Retour Lunii | Return to start | Ritorno all’inizio |
| Éditeur graphe | Graph editor | Editor a grafo |
| Éditeur par menus | Menu editor | Editor a menu |
| Éditeur simplifié | Simple editor | Editor semplificato |
| File de rendu | Generation queue | Coda di generazione |
| Préférences (application) | Preferences | Preferenze |
| Réglages (selected item) | Settings | Impostazioni |
| Emplacement de travail | Workspace folder | Cartella di lavoro |
| Agréger des packs | Combine audiobooks | Unisci audiolibri |
| Vérifier un pack / vérificateur | Check an audiobook / Audiobook checker | Verifica un audiolibro / Verifica audiolibri |

Notes:

- An **audiobook** / **audiolibro** is the whole object (and the file that holds
  it). A **Story** / **Storia** is one element inside it. Never translate
  "histoire" by "audiobook".
- The word "pack" does not appear in English or Italian text. File names, logs
  and technical codes keep it.
- "Preferences" is the application. "Settings" is the selected item. Do not use
  one for the other.
- Editor names are lowercase in the middle of a sentence ("in the graph editor",
  "nell’editor a grafo") and capitalized in titles and at the start of a
  sentence.
- French uses the same verb for saving a file and for recording with a
  microphone. Check the `context` to pick *Save* / *Salva* or *Record* /
  *Registra*.

### Tone

- Readers are parents, teachers and creators, often without technical
  background. They know their Lunii, not graphs or file formats.
- **French:** informal address (`tu`): "Choisis un fichier".
- **English:** American English (`color`, `canceled`), neutral and friendly
  `you`. Contractions (`can’t`, `isn’t`) are fine.
- **Italian:** informal `tu`, never `Lei`: "Salva", "Scegli", "Scaricalo di
  nuovo". Do not mix `tu` and `Lei`.
- Buttons and menu items start with an imperative verb and have no final period.
  Tabs, panels and section titles are nouns.
- Use the active voice: "Story Studio created the audiobook".
- Error messages say what happened, then what to do. Do not blame the reader.
  Technical details go last, in parentheses or in the collapsible detail.
- Do not use internal words in visible text (`stage`, `funnel`, `ref`, `node`,
  `Action`). `node` / `nodo` is tolerated in the graph editor and diagnostics.
- If the translation is longer than `maxLength`, rephrase. Italian is often 15%
  to 30% longer than French.

### Typography

| | French | English | Italian |
|---|---|---|---|
| Capitalization | Initial capital only | Sentence case everywhere | Initial capital only; days, months and languages in lowercase |
| Before `: ; ! ?` | Non-breaking space | No space | No space |
| Quotation marks | `« … »` with non-breaking spaces | `“…”`, `‘…’` inside | `«testo»` with no inner space, `“…”` inside |
| Apostrophe | `’` | `’` | `’` |
| Lists | | Serial comma: "images, audio, and text" | No comma before `e` |
| Ellipsis | `…` (one character), only when the command asks for more input ("Save as…") | same | same |

In Italian, write `È` with the accent (never `E'`), `perché`, `poiché`, `po’`,
`qual è`. Punctuation goes outside the quotation marks, except a `?` or `!` that
belongs to the quoted text. Do not hand-format numbers and dates: the application
formats them with `Intl` for the active language.

## Adding a language

Replace `xx` below with the language code (for example `de`).

1. **Create the catalogues.** Copy every file of `src/locales/fr/` to
   `src/locales/xx/` (all 14 namespaces, including `rust` and `native`) and
   translate the values. Keep the keys. Add the plural categories of the
   language: list them with
   `node -e "console.log(new Intl.PluralRules('xx').resolvedOptions().pluralCategories)"`.
2. **Add `_meta` entries.** In each `src/locales/_meta/<namespace>.json`, add an
   `"xx": { "sourceHash": "…", "status": "…" }` block to every key. The hash is
   the one already used by the other languages for the same key.
3. **Register the resources** in `src/i18n/index.js`: import the 14 files and add
   an `xx` entry to `resources`.
4. **Declare the language** in `src/i18n/language.js`: add `'xx'` to
   `DEV_LANGUAGES` and add its `Intl` locale to `INTL_LOCALES` (for example
   `xx: 'de-DE'`). Do not add it to `PUBLIC_LANGUAGES`; maintainers do that when
   the catalogues are complete.
5. **Name the language in the selector.** In
   `src/tabs/OptionsTab/InterfaceSection.jsx`, add `xx` to `LANGUAGE_LABEL_KEYS`
   and add the key `interface.language.<name>` to the `settings` catalogues (the
   language written in its own name, such as `Deutsch`) and to
   `_meta/settings.json`. If the value is identical to French, the key must also
   be in `SETTINGS_NEUTRAL_KEYS`.
6. **Update the checker** `scripts/check-i18n.mjs`: add `'xx'` to `LANGUAGES`
   and to the two `['en', 'it']` loops that verify the `_meta` blocks, and add
   per-language entries to the neutral lists that are keyed by language
   (`HELP_NEUTRAL_KEYS`, `AI_NEUTRAL_KEYS`, `CHECKER_NEUTRAL_KEYS`,
   `EXAMPLES_NEUTRAL_KEYS`) when your language needs them.
7. **Update the places that list languages by code:**
   - `src/i18n/checkerPresentation.js`: the locale used for the decimal separator.
   - `src/i18n/examplesPresentation.js`: `EXAMPLE_LANGUAGES` and the example
     resources.
   - `src/components/AdvancedWorkspace/ExampleDialog.jsx`: `LANGUAGE_KEYS`, with
     the matching `ai:voice.language.xx` key.
   - `src/store/advancedExamples/media.js`: `EXAMPLE_PIPER_VOICES`, only if a
     Piper voice for that language exists in
     `src-tauri/src/services/piper/catalog.rs`.
   - `scripts/i18nTestSetup.mjs`: the test setup imports each language.
8. **Native surfaces.**
   - Dialog titles and file filters are keys of the `native` namespace, already
     covered by step 1.
   - Windows installer: in `src-tauri/tauri.conf.json`, add the NSIS language
     name (for example `German`) to `bundle.windows.nsis.languages`. Keep
     `English` first: it is the fallback.
   - macOS: create `src-tauri/macos/xx.lproj/InfoPlist.strings` with the
     translated `NSMicrophoneUsageDescription`. Declare it in
     `bundle.macOS.files` of `tauri.conf.json`
     (`"Resources/xx.lproj/InfoPlist.strings": "macos/xx.lproj/InfoPlist.strings"`)
     and add `<string>xx</string>` to `CFBundleLocalizations` in
     `src-tauri/Info.plist`.
9. **Run the checks** (next section) and test the language in
   `npm run tauri:dev`.

## Checks before a pull request

```sh
npm run lint
npm run check:i18n
node --test scripts/*.test.mjs
```

- `npm run lint` rejects visible text written directly in the code instead of
  going through `t(...)`.
- `npm run check:i18n` verifies, for every language: no missing or orphan keys,
  the plural categories, identical `{{params}}` and tags, no untranslated French
  text, valid `_meta` blocks, up-to-date `sourceHash`, and the Rust codes. It
  prints `maxLength` overruns and unused keys as warnings. Errors fail the
  command.
- The test suite includes the i18n tests.

Then check the result with your eyes, in the running application:

1. Start `npm run tauri:dev`.
2. Switch to **Pseudo-locale** and browse the screens you changed. Truncated
   text, overlaps, or plain French without pseudo-locale accents reveal a layout
   or code issue.
3. Switch to your language and check the same screens, including plurals and
   messages with tags.

In the pull request, list the languages and namespaces you changed and any key
you added to a neutral list.
