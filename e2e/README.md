# e2e — piloter Story Studio réel sous Windows

Outillage de test qui pilote **l'application réelle** : la WebView2 lancée par `tauri dev`, les vraies
commandes Rust, FFmpeg, 7z et le simulateur. Il n'entre dans aucun build.

## Démarrage

```powershell
cd e2e
npm install                                   # playwright-core, une fois
copy local.config.example.json local.config.json   # puis renseigner les chemins du poste
cd ..
node e2e/run.mjs fumee                         # parcours de fumée
```

`local.config.json` est ignoré par git. **Aucun chemin personnel ni nom de pack réel ne doit être
versionné dans `e2e/`.** Les variables d'environnement `SS_E2E_CORPUS_DIR`, `SS_E2E_STUDIO_DIR`,
`SS_E2E_JAVA_HOME` et `SS_E2E_WORK_DIR` remplacent les clés du fichier. Les noms des projets
personnels rejoués par `c3a-projets` et `c3b-parity-menus` viennent des clés `userProjects` et `c3bUserProjects` (ou de
`SS_E2E_USER_PROJECTS` et `SS_E2E_C3B_USER_PROJECTS`) : aucun défaut n'est versionné.

Artefacts d'exécution : `%TEMP%\ss-e2e\runs\<parcours>-<horodatage>\`. On y trouve les captures
numérotées, `events.jsonl` (erreurs console, exceptions, IPC en échec), `ipc.jsonl` (toutes les
commandes IPC, dans l'ordre), `tauri-dev.log` (log Rust) et `result.json` (le verdict).

## Comment ça marche

- **Lancement** (`lib/launch.mjs`) : `npm run tauri -- dev --config src-tauri/tauri.e2e.conf.json`
  avec `VITE_E2E=1`.
  - La config e2e change l'identifiant en `com.hugs11.story-studio.e2e`. Le profil WebView2, les
    logs, les sessions et le cache sont donc isolés de l'usage réel, sous
    `%LOCALAPPDATA%\com.hugs11.story-studio.e2e\`.
  - Elle ouvre aussi le port CDP 9222. Playwright s'y connecte par `connectOverCDP`.
  - Elle passe aussi `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` : la
    WebView2 e2e accepte seule la demande micro et utilise un micro factice. `c5-micro allow` ne
    demande donc aucun clic. La vraie fenêtre d'autorisation Windows n'est pas exercée ; elle se
    vérifie à la main dans la recette. `c5-micro refuse` simule le refus en faisant rejeter
    `getUserMedia` (`NotAllowedError`), car `Browser.setPermission` ne contredit pas l'acceptation
    automatique.
  - `fresh: true` efface ce profil e2e, et lui seul.
  - **Une seule instance à la fois**, car les ports 1420 et 9222 sont fixes.
  - La souris et le clavier du poste ne sont pas utilisés.
  - `app.stop()` ferme par `taskkill /F` (arrêt brutal, jamais de garde
    `tauri://close-requested`, donc jamais de flush WebView2/localStorage
    garanti). `app.stop({ graceful: true })` ferme par la même voie qu'un
    clic sur la croix de la fenêtre (IPC `plugin:window|close`), qui
    déclenche `useWindowCloseGuard` (garde d'enregistrement, `beforeClose`,
    `win.destroy()`) avant que le process ne s'arrête de lui-même ; repli sur
    `taskkill /F` si la fenêtre ne s'est pas fermée sous 15 s (ex. boîte
    « Enregistrer avant de quitter ? » restée sans réponse — poser
    `answerNext(page, 'ask', false)` avant l'appel si le projet peut être
    dirty). Le résultat porte alors `closedGracefully`. Utile pour distinguer
    un artefact d'arrêt brutal d'un vrai comportement applicatif (ex. la présence
    d'un projet dans les récents).
- **Boîtes de dialogue** (`shim/dialog.js`, `lib/dialogs.mjs`) :
  - Sous `VITE_E2E=1`, `vite.config.js` substitue un shim à `@tauri-apps/plugin-dialog`.
  - `answerNext(page, 'open' | 'save' | 'ask', valeur)` pose la réponse du prochain appel.
  - Sans réponse posée, l'appel est annulé : aucune boîte native ne bloque l'agent.
  - `dialogLog(page)` dit ce que l'app a demandé, notamment le `defaultPath` : c'est un fait utile
    pour les chemins.
- **Dépôt de fichiers** (`lib/drop.mjs`) : `dropFiles(page, sélecteur, [chemins])` émet la séquence
  `tauri://drag-enter/over/drop` au centre de la cible. Les zones de dépôt sont
  `[data-funnel-drop]` (funnels) et `[data-os-drop-zone]` (arbre, médiathèque).
- **Ouvrir un projet sans dialogue** : l'enregistrer par `answerNext(page, 'save', …)` puis
  `Ctrl+S`, et le rouvrir par `button.mode-proj-row` sur l'accueil (les récents).
- **Gestes vérifiés** (`lib/actions.mjs`) :
  - `importPack(page, archive, { editor: 'menus' | 'graphe' })`. Un pack « graphe seulement »
    s'ouvre sans demander l'éditeur.
  - `generatePack(page, dossier, { uuid: 'keep' | 'new' })`. Ce geste enchaîne Ctrl+G, la fiche,
    « Appliquer & générer », la révision d'UUID et le dossier scripté, puis attend l'archive.
  - `newProject(page, 'simple' | 'pack' | 'advanced')` : depuis l'accueil, ouvre un nouveau projet
    dans le mode donné et attend l'éditeur (barre d'outils « Projet » visible ; pour `'advanced'`,
    attend en plus « Générer le pack » actif).
  - `returnHome(page)` : retour à l'accueil par l'interface (menu « Projet » → « Retour à
    l'accueil »), en traversant la boîte « Projet non enregistré » (« Quitter sans enregistrer »)
    si le projet est dirty — un projet neuf l'est dès sa création.
  - `projectMenuButton(page)` : le bouton « Projet » de la barre d'outils, par
    `[data-toolbar-id="project-menu"]`. À utiliser plutôt que
    `getByRole('button', { name: 'Projet' })` : ce nom accessible matche aussi, en sous-chaîne, le
    fil d'Ariane du nom de projet (« Projet A », « Projet non enregistré »…) dès qu'il est
    lui-même un bouton, ce qui viole le mode strict de Playwright.
  - `closeFunnel(page)` : ferme le funnel ouvert par son bouton « Fermer » (croix du châssis
    commun), scopé à `[role="dialog"]`/`[role="alertdialog"]` — le bouton natif de fermeture de la
    fenêtre (coin haut-droit) porte lui aussi `title="Fermer"`, donc le même nom accessible sans ce
    cadrage. Renvoie `false` sans effet si le bouton est désactivé (fermeture bloquée pendant une
    opération en cours).
- **Corpus** (`lib/corpus.mjs`) : `smallestArchive(sousDossier)`, `smallestArchives(sousDossier, n)`
  et `smallestByExt(sousDossier, ext)` choisissent dynamiquement, par taille, les archives d'un
  sous-dossier de classement sous `config.corpusDir` (ex. `'01 - Editable'`). Aucun nom de pack
  réel n'est donc jamais versionné dans un parcours ; seuls des noms de catégories le sont.
- **Médias fixtures** (`lib/fixtures.mjs`) : `extractFixtureMedia(destDir)` extrait un `.wav` et un
  `.png` réels du fixture repo `advanced-export/export-mvp.zip` (avec le `7z` fourni à l'app), pour
  les funnels qui demandent un fichier « normal » hors pack (ex. audio/image racine d'« Agréger des
  packs »).
- **Pack au format FS** (`studio/studio.mjs`) : `convertToFsFolder(zipPath, outDir)` convertit une
  archive en pack FS (dossier), par le même chemin STUdio que `studioVerdict`, pour fabriquer un
  pack FS à déposer dans « Modifier un pack existant ».
- **Sélecteurs** : les boîtes de l'app sont souvent des `alertdialog`, et certains conteneurs
  portent `aria-hidden`. `clickButton` retombe alors sur le texte visible — y compris quand un
  bouton porte un `aria-label` (souvent un texte de tooltip) qui remplace son nom accessible et
  diffère de son texte affiché (ex. le CTA « Appliquer & générer » du panneau de métadonnées, dont
  le nom accessible est en réalité la description longue de l'action). Dans ce cas, préférer
  `clickButton`/un filtre par texte visible (`button:visible` + `hasText`) à `getByRole(..., {
  name })`.
- **Processus orphelin** (`lib/launch.mjs`) : `cargo run` (sous `tauri dev`) laisse parfois
  échapper `story-studio.exe` du sous-arbre tué par `killTree`, ce qui peut ensuite faire échouer
  `resetAppProfile` avec `EPERM` (profil verrouillé) au lancement suivant. `stop()` et `launchApp()`
  balaient donc aussi, par un filet (`killOrphanedAppProcesses`), tout `story-studio.exe` dont
  l'exécutable est sous ce dépôt (jamais l'installation réelle de l'auteur, ailleurs sur le disque).

## Oracles (`lib/oracles.mjs`)

Ils ne dépendent d'aucune spécification : ce qui relève de l'intention se rapporte « à arbitrer ».

- `readbackPack(page, zip, dossierStudio)` : validateur Lunii de l'app, puis lecteur de pack de
  l'app, puis **STUdio** (`studio/studio.mjs`, le vrai code de conversion STUdio 0.5.4, sans
  toucher `~\.studio`). `ok` exige les trois, et le même nombre d'écrans.
- `inventory(dossier)` et `inventoryDiff(avant, après)` : ce qu'une opération a écrit ou laissé
  (`.partial`, copies orphelines…).
- `events.faults()` : exceptions et erreurs console.
- Chaque oracle a sa **contre-épreuve**, qu'il faut garder : une entrée fautive doit le faire
  échouer. Exemple : le zip tronqué de la fumée.

## Trace d'une simulation (`lib/simulator.mjs`)

Le DOM du simulateur (`LuniiShell.jsx`, classe `.lunii-sim`) est strictement le même quelle que
soit sa provenance : document en cours (`DocumentSimulationPanel`),
archive produite (`ZipReviewPanel`, « Simulation de l'archive exportée ») ou pack posé dans l'arbre
(« Simuler ce pack… »/« Simuler depuis ici »). `simulator.mjs` ne sait pas d'où vient l'écoute : il
lit `.lunii-sim` et pilote ses boutons, ce qui rend une trace comparable entre le projet et
l'archive qu'il produit.

- `DEFAULT_SCRIPT` : script fixe de boutons (OK/molette gauche/droite/Maison, ~50 pas), partagé par
  toutes les traces d'une même comparaison — c'est la comparabilité qui compte, pas la richesse du parcours.
- `runTrace(page, script)` : rejoue le script sur un simulateur déjà ouvert, renvoie
  `{ steps, stuckAt }`. Chaque étape porte l'état affiché avant/après (titre, sous-titre, présence
  d'image, boutons actifs, barre de lecture et durée). **Choix documentés** :
  - un Écran en lecture automatique dont le bouton OK est désactivé (`cs.ok` faux, invariant
    « `ok_transition` existe seulement si `ok || autoplay` ») fait attendre l'avance automatique au
    lieu de cliquer un bouton désactivé ; si elle ne vient pas sous `autoWaitMs` (7 s par défaut) et
    que Maison est disponible (observé : il l'est souvent, même en cours de lecture), on presse
    Maison pour continuer plutôt que d'attendre la fin réelle d'une histoire de plusieurs minutes —
    même règle des deux côtés, donc comparable. Seul un Écran qui n'avance ni seul ni par Maison est
    un vrai blocage (`stuckAt`).
  - la durée audio n'est lue qu'une fois stabilisée sur deux relevés consécutifs
    (`waitAudioSettled`) : la barre de lecture apparaît dès que le lecteur existe, la durée
    seulement une fois les métadonnées chargées, et la source archive (`get_pack_asset`, IPC) est
    structurellement plus lente à démarrer que la source projet (lecture locale) — sans cette
    attente, un relevé pris trop tôt confond un chargement en cours avec un Écran muet ou une durée
    différente (vérifié en pratique lors de l'écriture de l'outillage).
- `compareTraces(traceA, traceB)` : oracle principal sur **la séquence** (titre, sous-titre, image,
  boutons, présence audio) — jamais les chemins de fichiers ni l'IPC brut, qui diffèrent
  structurellement entre un projet et une archive. La durée audio est vérifiée **séparément**
  (`durationGaps`, tolérance 1 s) et **ne fait pas échouer `identical`** : une vérification
  indépendante (ffprobe, hors DOM) a montré qu'un écart de durée peut être réel et systématique
  (traitement audio appliqué à l'export, que `project_pack_for_simulation` n'applique pas
  lui-même) sans que la navigation elle-même diverge — les deux questions sont donc rapportées
  séparément plutôt que noyées dans un seul verdict.
- `launchSimulatorFromToolbar(page)` : bouton « Lancer le simulateur »
  (`[data-media-tool="simulator"]`, ouvre l'overflow « Plus d'actions » si besoin) — commun à
  l'arbre, au diagramme et au canvas graphe.
- `openTreeContextMenu`/`clickContextMenuItem` : menu contextuel partagé (`.ctx-menu`/`.ctx-item`,
  arbre/diagramme/graphe).

`c7-s7-graphe.mjs` couvre le départ contextuel réel depuis un Écran, la fermeture commune du
simulateur et la carte « Génération groupée ». Il applique deux viewports CDP (1366×768 et
1920×1080), puis amène le séparateur de l'Inspecteur à ses deux bornes par un glisser réel. Les
quatre captures contrôlent à la fois l'absence de débordement, la place du texte et celle des deux
boutons.

`c7-s8-reglages-etroits.mjs` vérifie les panneaux Réglages des deux éditeurs à leur largeur
minimale de 200 px, avec un pack passé en argument. Il capture les quatre types d'écran des menus
(racine, histoire, dossier et fin), puis les réglages de l'Écran racine, les contrôles d'un Écran avec
le plus de choix, et une Liste de choix avec les captures de ses arrivées dans le graphe. Chaque carte
de réglages est capturée séparément pour parcourir aussi les sections plus longues :
`node e2e/run.mjs c7-s8-reglages-etroits <archive.zip>`.

`c7-s9-panneau-ecran-etroit.mjs` passe **chaque** Écran et chaque Liste de choix d'un pack graphe avec
l'Inspecteur à 200 px. Deux faits sont mesurés dans le DOM : aucun élément ne sort de sa carte (la
boîte visible compte, rognée par les ancêtres qui coupent leur contenu), et aucun libellé ne passe sous
l'interrupteur de sa ligne. Les cartes des premiers nœuds sont capturées une à une pour la relecture
humaine. Le redimensionnement au séparateur est partagé avec `c7-s8` (`lib/settings-panel.mjs`) :
`node e2e/run.mjs c7-s9-panneau-ecran-etroit <archive> [nombre de captures]`.

## Lire le document graphe sans sonde (`lib/c4-helpers.mjs`)

Le `.mbah` porte `authoring.payload`, une chaîne opaque (`store/projectModel/authoring.js`).
`readGraphView(page, mbahPath)` la lit sur disque puis la fait projeter par l'IPC déjà utilisée par
l'app, `read_advanced_graph_view` (DTO `AdvancedGraphView`, `native_pack/graph_view/dto.rs`), qui
porte `documentFingerprint` — une empreinte des octets exacts du payload lu. `sameDocument(vueA,
vueB)` compare cette empreinte : c'est l'oracle d'égalité entre deux états d'un même document
(avant/après un enregistrement, un annuler, une réouverture). Toujours précédé d'un enregistrement
(`snapshot()` dans `c4-invariants.mjs` : Ctrl+S puis lecture) — un enregistrement ne mute pas le
document et ne pousse rien dans l'historique, donc relire après coup reflète l'état en mémoire sans
fausser un `Ctrl+Z` qui suivrait.

Sélection et gestes d'auteur, le canvas n'exposant rien au DOM (« l'accessibilité et le clavier
passent par la liste de recherche et par l'Inspecteur », `GraphCanvasStage.jsx`) :

- `selectGraphNode(page, nom, 'stage'|'action')` : clic dans la liste de recherche
  (`li[role="option"][data-kind=…]`, `GraphSearchPanel.jsx`) — sélection simple, ouvre l'Inspecteur.
- `selectGraphNodeByPath(page, chemin)` : par chemin exact (id de la ligne =
  `advanced-option-<encodeURIComponent(path)>`), pour viser un nœud précis quand un autre partage le
  même nom affiché (ex. juste après un collage).
- `createGraphStage`/`createGraphAction` : boutons de la barre du panneau Graphe.
- `renameSelectedNode(page, nom)` : F2 → champ « Nom » de l'Inspecteur (`getByLabel('Nom', {exact:
  true})` — **sans `exact`, ce sélecteur matche aussi, en sous-chaîne insensible à la casse, le
  bouton de la fiche du pack de la barre de titre**, dont l'aria-label contient « le **nom** et les
  métadonnées »).
- `wireStageOkToSelectedAction`/`addActionDestination` : formulaires de `ActionEditor.jsx »
  (« Relier un Écran » / « Ajouter un choix ») — c'est le chemin utilisé pour « raccorder »
  sans piloter le glisser de lien à la souris (prises de port dessinées par le canvas, jugé trop
  coûteux à fiabiliser). `selectNodePickerOption` choisit l'option d'un `<select>` de
  `NodePicker.jsx` par **valeur** (le chemin du nœud), jamais par `selectOption({label})`, qui
  n'accepte pas de RegExp et exige une égalité exacte alors que le picker peut suffixer
  « (sans nom) » ou « — identifiant dupliqué ».
- `nodeOverlayCenter(page, chemin)` : coordonnées écran d'un nœud peint, via la couche de survol
  HTML (`GraphNodeOverlays.jsx`, `[data-node-path]`) — permet un clic/glisser piloté par
  `page.mouse` (multi-sélection Ctrl+clic, déplacement) là où la liste ne suffit pas (son `onClick`
  ne lit aucun modificateur, rien n'implémente Maj+Flèche pour elle). Fiabilité limitée constatée
  dans `c4-invariants.mjs` : à consolider avant réutilisation.
- `ipcErrors(events)`/`tauriLogErrors(runDir)` : signaux qu'`events.faults()` ne porte pas (erreurs
  IPC, lignes `ERROR` du log Rust) — utiles pour un échec silencieux comme un premier enregistrement qui n'écrit rien.

## Corpus réduit et test de release

Le corpus réduit (fichier indiqué par `reducedCorpusFile`) liste des entrées —
packs réels, packs synthétiques et projets consolidés — chacune avec son **verdict attendu** :
éditeur d'ouverture, points « à corriger », génération, correction proposée, relecture. Les fichiers
sont rangés dans `corpus/` à côté du manifeste local (hors git, transférés à la main,
vérifiés par `sha256`). Les noms et chemins personnels restent dans les fichiers locaux, hors git.

- **Test de release, étage 1** : `node e2e/release/release-test.mjs [--only motif] [--reference
  resultats.json]`. Prépare le plan (un projet est exporté par `projectToRustExport`, chemins médias
  absolus), lance le test Rust ignoré `native_pack/tests/release_corpus.rs` (profil debug : seul
  profil où `STORY_STUDIO_FFMPEG_PATH` et `STORY_STUDIO_7Z_PATH` désignent les outils de
  `src-tauri/tools/` ; pile de 256 Mo par entrée), relit chaque archive produite par STUdio et
  Lunii.QT, compare au verdict attendu et à la référence. Sorties dans `<workDir>/release/<horodatage>/`
  (`rapport.md`, `resultats.json`, `constats.jsonl`). STUdio est validé sur conversion et relecture
  avec le même nombre d'écrans ; une baisse du nombre de listes relues (choix aléatoires représentés
  autrement par le format de l'appareil) est notée `studioNote`, pas refusée.
- **Résolution** : `SS_E2E_REDUCED_CORPUS` (variable), la clé `reducedCorpusFile` de
  `local.config.json`. Aucun manifeste n’est détecté automatiquement : renseigner explicitement
  ce chemin sur chaque poste. Lu par `lib/reduced-corpus.mjs`.
- **Test de release, étage 2** : `node e2e/run.mjs release-ui` (≈ 7 min). Neuf étapes dans l'app réelle,
  sur des entrées du manifeste choisies par leur rôle (jamais par leur nom) : ouverture par menus,
  passerelle « Continuer dans l'éditeur graphe… », ouverture graphe, gros `.7z` à longue
  vérification, « à corriger » puis correction en un clic, enveloppe multi-pack, archive illisible
  (message lisible), projet de l'éditeur simplifié, exemple publié par le README (les deux éditeurs
  proposés, génération par menus puis par la passerelle vers le graphe). Chaque archive est relue (validateur, lecteur,
  STUdio, Lunii.QT) ; l'app est relancée après un échec. `generatePack` attend la fin réelle de la
  vérification (`waitValidationSettled`), ne conclut au refus que si « à corriger » > 0, et, avec
  `events`, exige qu'une commande de génération parte dans les 30 s.
- **`c3a-corpus.mjs --reduit`** (`node e2e/run.mjs c3a-corpus --reduit`) : remplace le tirage aléatoire
  par taille (`spreadArchives`) par les packs du corpus réduit, choisis par leur verdict d'ouverture
  attendu (`reducedArchivesUnder`). Sans l'argument, comportement inchangé.
- **`l07_campaign`** (`src-tauri/src/native_pack/tests/l07_campaign.rs`, code de test) : banc de la chaîne
  par menus sur un gros corpus (`STORY_STUDIO_L07_LIBRARY`) ; `SS_L07_KEEP_DIR` génère chaque pack deux
  fois et conserve les deux zips, avec un verdict de déterminisme. Le corpus réduit, lui, passe par le
  test de release, qui porte son propre contrôle de déterminisme. Voir le module pour le détail.
- **Campagne « Écran d'entrée »** (`src-tauri/src/native_pack/tests/entry_campaign.rs`, code de test,
  ignorée par défaut) : mesure, sur tout le corpus (`.zip` et `.7z`, hors `Triage avance`), les options
  visant l'entrée, l'Accueil actif sans destination sur l'entrée, les Accueils explicites en boucle et
  les retours dérivés, après import graphe (`import_pack_as_advanced_document`) et après copie par la
  passerelle (`graph_copy_of_project`), avec les diagnostics réellement émis. Variables :
  `STORY_STUDIO_ENTRY_LIBRARY`, `STORY_STUDIO_ENTRY_OUTPUT` (jsonl), `STORY_STUDIO_ENTRY_LIMIT`
  (optionnelle), `STORY_STUDIO_ENTRY_SKIP`, `STORY_STUDIO_ENTRY_STACK_MB` (pile du fil de mesure, 256 par
  défaut) ; lancement `cargo test --lib entry_measures_import -- --ignored --nocapture`. Ne génère rien.
- **STUdio sur les sorties conservées** : `node e2e/studio/studio-on-l07-outputs.mjs <SS_L07_KEEP_DIR>`
  passe l'oracle STUdio (`studio.mjs`) sur chaque zip conservé, sans lancer l'app.


## Mesures sans l'app : l'Écran d'entrée dans le `story.json` source (`mesures/entree-source.mjs`)

`node e2e/mesures/entree-source.mjs [dossierSortie]` parcourt toutes les archives `.zip` et `.7z` de
`corpusDir` (récursif, hors `Triage avance`), liste chaque archive avec le `7z` fourni à l'app et mesure
chaque `story.json` trouvé (enveloppes multi-pack et archives imbriquées comprises, extraites sous
`%TEMP%\ss-e2e\mesures`, jamais dans le corpus). Par `story.json` : options vers l'entrée, entrée avec
Accueil actif sans destination, Accueil explicite qui boucle sur l'Écran (entrée / autres), retours Lunii
dérivés (règle de `defaultHomeReturns.js`), `okTransition` vers l'entrée. Les archives au format Lunii
brut (`.7z` d'origine, sans `story.json`) sont notées `noStoryJson`. Sortie par défaut :
`e2e/artifacts/entry-source/` (`entree-source.jsonl` et `-resume.md`), configurable par
`entrySourceReportDir` ou `SS_E2E_ENTRY_SOURCE_REPORT_DIR`.
Contre-épreuve : `node --test e2e/mesures/entree-source.test.mjs`.

## Corpus complet (`--tout`)

`node e2e/run.mjs c3a-corpus --tout` rejoue **toutes** les archives `.zip` et `.7z` du corpus, en ordre
stable (tri par chemin) : `01 - Editable` (menus puis graphe, relance de l'app entre les deux),
`02 - Lecture seule` (graphe), puis `03 - Non supporte`, `04 - Erreur import` et `05 - A verifier`
(verdict seul, sans génération ; un dossier vide est ignoré). Sans `--tout`, le parcours est inchangé.
Le déterminisme n'est mesuré que si `SS_E2E_C3A_DETERMINISM_COUNT` est posé.

Chaque ligne du jsonl (`c3c-corpus.jsonl`) porte `relPath` (relatif à `corpusDir`, identifiant du pack)
et `openVerdict` : `choix-editeur` (menus et graphe proposés), `graphe-seul` (atterrit sans choix),
`lecture-seule`, `non-supporte`, `refus`, `enveloppe` ou `timeout`. `expectedByCategory` donne le verdict
attendu de la catégorie et `openVerdictExpected` vaut `false` en cas d'**écart** (ex. un Editable qui
n'offre plus le choix, un Lecture seule qui offre les menus) : c'est un constat, pas un échec à
contourner. Un éditeur demandé mais absent donne `importOk:false` + raison, et la suite continue.

Variables (toutes facultatives) :

- `SS_E2E_C3A_REPORT_DIR` : destination (clé `c3cReportDir`, défaut `e2e/artifacts/corpus-complet`).
  On y trouve `c3c-corpus.jsonl` et `progress.json`.
- `SS_E2E_C3A_RESUME=1` : lit le jsonl existant et saute les couples `(relPath, editor)` déjà relevés.
- `SS_E2E_C3A_KEEP_DIR=<dossier>` : copie chaque zip généré sous `<dossier>/<category>/<index>-<editor>.zip`
  et écrit `manifest.jsonl` (`relPath`, `editor`, `zip` relatif au dossier), pour un oracle externe
  (Lunii.QT) passé après coup.
- `SS_E2E_C3A_PACK_TIMEOUT_MS` (défaut 900000) : plafond dur par chaîne (import + génération + relecture).
  Dépassé, la chaîne est relevée `timeout`, l'app est relancée et la suite continue.
- `SS_E2E_C3A_LIMIT=<n>` : mini-série, les `n` plus petites archives par catégorie **et par format**
  (`.zip` / `.7z`), de sorte qu'un `.7z` soit toujours couvert.

`progress.json` est réécrit au début et à la fin de chaque chaîne : `{ startedAt, updatedAt, done, total,
current: { relPath, editor, step }, okCount, failCount, lastError }`. Un chien de garde y lit sur quoi
ça coince (`updatedAt` qui ne bouge plus, `current.step`).

## Oracle Lunii.QT (`luniiqt/`)

Dit si une archive au format STUdio (`story.json` + `assets/`) serait acceptée et convertie par
[Lunii.QT](https://github.com/o-daneel/Lunii.QT), sans appareil et sans lancer l'app.

- **Installation** : `node e2e/luniiqt/setup.mjs` (clone de Lunii.QT au commit épinglé dans
  `luniiqt/setup.mjs`, venv Python 3.11, dépendances de lecture de pack, **sans PySide6**). Dossier :
  clé `luniiqtDir` de `local.config.json` ou `SS_E2E_LUNIIQT_DIR`, défaut `<workDir>/luniiqt`
  (`%TEMP%\ss-e2e\luniiqt`). Python : `SS_E2E_PYTHON` sinon `python` du PATH.
- **API** : `luniiqtVerdict(zipPath)` (`luniiqt/luniiqt.mjs`) renvoie
  `{ ok, format_detected, stage_count, action_count, errors[], warnings[], elapsed_ms, expected, readback, square_one }`.
  `node e2e/luniiqt/luniiqt-on-outputs.mjs <dossier> [sortie.jsonl]` la passe sur tous les `.zip`
  (récursif) et écrit un jsonl.
- **Ce qui est exécuté** : le vrai `LuniiDevice.import_story` de Lunii.QT (détection du format,
  `StudioStory`, conversion `ni`/`li`/`ri`/`si`/`rf/`/`sf/`/`bt`, image RLE4, audio). Seuls l'appareil
  (dossier temporaire, Lunii V2, clé d'appareil nulle : elle ne sert qu'au fichier `bt`) et PySide6
  (`luniiqt/stubs/`, simple base `QObject`/signaux) sont simulés ; `~/.lunii-qt` est redirigé vers le temp.
  Relecture structurelle : nœuds de `ni` = stages, `li`/transitions dans les bornes, tailles `ri`/`si`,
  fichiers `rf`/`sf` produits.
- **Limites** : aucun appareil réel (comportement du firmware, `bt` authentique, chiffrement V3 non
  testés) ; sans `ffmpeg` sur le poste, un audio à transcoder (non MP3, non mono, < 44,1 kHz) fait
  échouer l'import comme chez Lunii.QT sans ffmpeg ; les options vers un uuid inexistant sont
  **acceptées** par Lunii.QT (index `-1`), l'oracle les rapporte en `warnings` ; la validité du graphe
  au sens du firmware n'est pas jugée.
- **Écran d'entrée** : Lunii.QT ne traite pas `squareOne` à part. Une option qui le vise devient un
  index dans `li` comme une autre ; `home: true` avec `homeTransition: null` s'écrit tel quel (drapeau
  Maison à 1, transition `-1/-1/-1`), sans erreur ni avertissement. Le premier `stageNodes` est le nœud 0
  de `ni` et donne l'identifiant du pack (`squareOne` non premier n'est pas remis en tête).

## Écrire un parcours

Un fichier `parcours/<nom>.mjs` qui exporte `run(args)` :

```js
import { createRun } from '../lib/run-context.mjs';
export async function run() {
  const ctx = createRun('mon-parcours');
  // launchApp, gestes, ctx.shot(page, 'étiquette'), ctx.check('fait vérifié', booléen, détail)…
  return ctx.finish();
}
```

Il se lance par `node e2e/run.mjs <nom>`. `ctx.check(…, null)` veut dire « non exécuté » :
ne jamais le compter comme réussi.

## Dossiers de rapports locaux

Les clés de `e2e/local.config.json` sont facultatives, sauf le manifeste pour les parcours qui
l’utilisent. Les variables d’environnement prennent priorité ; les chemins relatifs des rapports
sont résolus depuis la racine du dépôt.

| Clé | Variable | Défaut |
|---|---|---|
| `reducedCorpusFile` | `SS_E2E_REDUCED_CORPUS` | Aucun ; requis pour le corpus réduit |
| `c3aReportDir` | `SS_E2E_C3A_REPORT_DIR` | `e2e/artifacts/corpus` |
| `c3cReportDir` | `SS_E2E_C3A_REPORT_DIR` | `e2e/artifacts/corpus-complet` |
| `c3aSuspectsReportDir` | `SS_E2E_C3A_SUSPECTS_REPORT_DIR` | `e2e/artifacts/suspects` |
| `c3bReportDir` | `SS_E2E_C3B_REPORT_DIR` | `e2e/artifacts/parity` |
| `entrySourceReportDir` | `SS_E2E_ENTRY_SOURCE_REPORT_DIR` | `e2e/artifacts/entry-source` |

Les bancs Vite utilisent `SS_BENCH_<MODE>_OUTPUT_DIR` (modes `GRAPH`, `SURFACE`,
`ATELIER`, `EXPORT`, `RECETTE`) ou le défaut ignoré `bench/artifacts/<mode>`.
Ces variables peuvent être enregistrées dans `.env.local`, ignoré par git.
`SS_BENCH_EXPORT_SANDBOX` permet aussi de choisir le bac à sable temporaire de génération.
