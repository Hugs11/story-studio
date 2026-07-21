> [🇬🇧 English](README.md) | 🇫🇷 **Français**

<p align="center">
  <img src="public/logostory.svg" alt="Story Studio" width="240">
</p>

<p align="center">
  Éditeur Windows moderne pour créer, agréger, tester et exporter des packs d'histoires compatibles Lunii.
</p>

<p align="center">
  <a href=".github/workflows/ci.yml"><img alt="CI: Windows build" src="https://img.shields.io/badge/CI-Windows%20build-2ea44f.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="#configuration-requise"><img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-0078D4.svg"></a>
  <a href="CHANGELOG.md"><img alt="Version 0.9.4" src="https://img.shields.io/badge/version-0.9.4-2F80ED.svg"></a>
  <a href="#statut-beta"><img alt="Status: beta" src="https://img.shields.io/badge/status-beta-f59e0b.svg"></a>
  <a href="https://tauri.app/"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB.svg"></a>
  <a href="https://react.dev/"><img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB.svg"></a>
</p>

Story Studio pour Lunii permet de créer des histoires, d'importer des packs
ZIP existants, d'organiser des menus, de vérifier les médias et d'exporter des
packs d'histoires compatibles Lunii dans un espace de travail Windows visuel.
Tout reste local : images, audio, navigation, simulation et export ZIP.

Importez vos médias, assemblez et découpez l'audio, recadrez les images,
organisez vos menus et vos récits, puis exportez un ZIP compatible Lunii sans
jongler entre plusieurs outils.

> Story Studio est un outil communautaire. Il n'est pas affilié à Lunii, ni
> soutenu ou sponsorisé par Lunii.

## Statut beta

Story Studio est actuellement en beta. L'app est utilisable, mais elle peut
encore contenir des bugs, des cas limites et des problèmes de compatibilité
avec certains packs communautaires. Garde des copies de sauvegarde de tes
projets importants et signale les problèmes reproductibles via les GitHub
issues.

## Dernière version

Story Studio 0.9.4 introduit un espace de travail unifié et réorganisable, un
diagramme par niveaux plus lisible, des parcours audio et image réutilisables,
et une meilleure fidélité des fins d'histoires de l'import à la génération.

- [Télécharger la dernière version](https://github.com/Hugs11/story-studio/releases/latest)
- [Lire les notes de version 0.9.4](https://github.com/Hugs11/story-studio/releases/tag/v0.9.4)
- [Voir le changelog complet](CHANGELOG.md)

## Packs de démonstration

Découvrez Story Studio avec deux packs prêts à ouvrir, parcourir dans le
simulateur et adapter dans l'éditeur :

<table>
  <tr>
    <td align="center" width="50%">
      <a href="https://drive.proton.me/urls/5ND49D487R#IxRa3Bd0Lm8L"><img src="docs/assets/demo-packs/leo-la-licorne.png" width="130" alt="Couverture de Léo la licorne"></a><br>
      <strong>Léo la licorne</strong><br>
      <a href="https://drive.proton.me/urls/5ND49D487R#IxRa3Bd0Lm8L">Télécharger sur Proton Drive</a>
    </td>
    <td align="center" width="50%">
      <a href="https://drive.proton.me/urls/H7ZTBC8S14#aj2WBn39jDRF"><img src="docs/assets/demo-packs/toudou-cache-cache.png" width="130" alt="Couverture de Toudou mon doudou et Cache-Cache"></a><br>
      <strong>Toudou mon doudou + Cache-Cache — intégrale</strong><br>
      <a href="https://drive.proton.me/urls/H7ZTBC8S14#aj2WBn39jDRF">Télécharger sur Proton Drive</a>
    </td>
  </tr>
</table>

Pour découvrir un pack dans Story Studio :

1. Téléchargez son fichier ZIP depuis Proton Drive.
2. Lancez Story Studio et cliquez sur **Modifier un pack existant**.
3. Sélectionnez le fichier `.zip` téléchargé.

Ces packs sont distribués séparément du logiciel. Leurs histoires, fichiers
audio et illustrations ne sont pas couverts par la licence MIT de Story Studio.

## En un coup d'œil

| | |
|---|---|
| **Statut** | Beta |
| **Plateforme** | Windows desktop |
| **Format projet** | `.mbah` |
| **Format d'export** | Packs ZIP compatibles Lunii |
| **Stack principale** | React 19, Vite, Tauri 2, Rust |
| **Workflow** | Accueil guidé, éditeur arborescent visuel, agrégation de packs ZIP, navigation par nœuds, explorateur de médias, simulateur |
| **Vie privée** | App locale, aucun backend hébergé, aucune télémétrie |

## Du premier import au pack prêt à jouer

Story Studio rassemble tout le parcours dans une application locale : partir
de ses propres fichiers ou d'un pack existant, préparer les médias, construire
la navigation, tester le résultat et exporter un pack prêt pour la boîte à
histoires.

### 1. Démarrer un projet ou importer des histoires

Créez selon vos envies, reprenez un travail enregistré, modifiez un pack ZIP/7z
existant ou partez d'un podcast ou de YouTube. Des parcours guidés
permettent aussi d'agréger plusieurs packs ou d'analyser un pack communautaire.

![Accueil guidé de Story Studio](docs/assets/screenshots/home-dark.png)

### 2. Préparer les fichiers audio

Importez ou enregistrez un son, puis ajustez-le avant de l'utiliser dans une
histoire. Un enregistrement long peut être découpé en extraits réutilisables ;
plusieurs fichiers peuvent aussi être réordonnés et assemblés en une seule piste
sans modifier les originaux.

![Édition précise d'une forme d'onde dans Story Studio](docs/assets/screenshots/audio-editor-dark.png)

| Découper un enregistrement en extraits | Assembler plusieurs fichiers en une piste |
|---|---|
| ![Découpe audio avec plusieurs extraits préparés](docs/assets/screenshots/Audio-decoupe-light.png) | ![Assemblage audio avec des sources réordonnables](docs/assets/screenshots/Audio-assemble-light.png) |

### 3. Créer les voix, générer les illustrations et adapter les images

Générez des voix localement avec Piper, prêt à l'emploi, ou utilisez XTTS pour
le clonage vocal avancé. ComfyUI peut produire des illustrations via un service
local ; les tâches vocales et visuelles restent suivies dans les files de
génération de Story Studio.

| Générer une voix localement avec Piper ou XTTS | Générer une illustration avec ComfyUI |
|---|---|
| ![Génération vocale locale avec Piper](docs/assets/screenshots/voice-generation-dark.png) | ![Génération d'une illustration avec un workflow ComfyUI](docs/assets/screenshots/comfyui-generation-dark.png) |

Les images peuvent ensuite être recadrées, redimensionnées et ajustées au
format 320×240 de la boîte à histoires.

![Recadrage et ajustement d'une image pour la boîte à histoires](docs/assets/screenshots/image-editor-dark.png)

### 4. Organiser l'histoire et tester sa navigation

Construisez les menus et les histoires dans l'arbre, attribuez leurs images et
leurs sons, puis définissez le rôle des boutons pendant et après la lecture.
L'explorateur Médias conserve les fichiers utilisés ou non à côté du projet.

![Espace unifié avec l'arbre, les réglages de l'histoire et le diagramme](docs/assets/screenshots/workspace-dark.png)

Le diagramme peut être ouvert en plein écran pour comprendre la structure
complète, les groupes d'histoires et les chemins de retour tout en conservant
l'organisation par niveaux.

![Diagramme complet par niveaux d'un grand pack d'histoires](docs/assets/screenshots/diagram-full-dark.png)

Le simulateur flottant permet ensuite de parcourir cette même navigation
directement au-dessus du diagramme avant l'export.

![Diagramme complet du projet testé dans le simulateur intégré](docs/assets/screenshots/diagram-simulator-dark.png)

### 5. Vérifier les réglages et générer le pack

Contrôlez les métadonnées publiques, la couverture, le nom du fichier et les
options audio ou de navigation communes au pack. Story Studio indique si le
projet est prêt, puis génère le ZIP compatible Lunii depuis le même espace de
travail.

| Vérifier les métadonnées avant l'export | Ajuster les réglages globaux de génération |
|---|---|
| ![Métadonnées du pack et nom du fichier généré](docs/assets/screenshots/pack-metadata-dark.png) | ![Réglages audio et navigation du pack](docs/assets/screenshots/Pack-settings.png) |

Les packs communautaires existants peuvent également être analysés séparément.
Le vérificateur regroupe les problèmes de structure, d'image et d'audio,
propose des corrections sûres et peut exporter un rapport détaillé.

![Vérificateur de pack communautaire et corrections proposées](docs/assets/screenshots/pack-checker-dark.png)

## Fonctionnalités

- **Éditeur visuel arborescent** avec menus imbriqués, multi-sélection, glisser-déposer et actions contextuelles.
- **Flux guidés depuis l'accueil** pour modifier un pack existant, créer depuis un podcast ou YouTube, agréger des ZIP et vérifier/corriger un pack communautaire.
- **Import de packs ZIP Lunii** : inspection, extraction en projet éditable, préservation des graphes ramifiés via références partagées, agrégation avec vos propres histoires.
- **Workflow audio intégré** : enregistrement micro, rognage, coupes, fondus, assemblage et insertion de silence.
- **Workflow image intégré** : recadrage 320×240 automatique, génération d'images textuelles depuis les noms.
- **Génération vocale locale** avec Piper par défaut et XTTS en option avancée.
- **Explorateur de médias** avec tags, filtres, compteurs d'utilisation et aperçus rapides.
- **Simulateur intégré** pour tester la navigation et les nœuds de fin avant export.
- **Validation et file de rendu** : vérifications de compatibilité et génération en série avec suivi des logs.
- **Intégrations locales optionnelles** YouTube via yt-dlp, XTTS (voix) et ComfyUI (images).
- **Confort projet** : sessions non enregistrées, enregistrement automatique, reprise après crash, versions de sécurité, raccourcis configurables, thèmes clair/sombre, vue diagramme.

## Pourquoi Story Studio ?

Je cherchais un outil simple pour créer des histoires audio pour mon enfant. En
tant qu'ancien monteur vidéo, je ne retrouvais pas dans les outils existants ce
qui me semblait essentiel : une interface visuelle, directe et fluide,
permettant de construire une narration sans friction, sans ligne de commande ni
structures de dossiers complexes.

Story Studio est né de ce besoin : rassembler l'import, les images, l'audio, la
navigation, la simulation et l'export dans un même espace clair, local et
compréhensible.

## Configuration requise

Windows 10 ou plus récent, avec WebView2. Les binaires tiers embarqués ont
leurs propres licences — voir [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Installation

Téléchargez l'installeur Windows depuis la
[page GitHub Releases](https://github.com/Hugs11/story-studio/releases/latest).

Pour compiler depuis les sources ou contribuer, voir
[CONTRIBUTING.md](CONTRIBUTING.md).

## Fichiers projet et espace de travail

Story Studio enregistre les projets sous forme de fichiers `.mbah`. Les
assets d'exécution sont organisés dans des dossiers d'espace de travail
gérés :

| Dossier | Rôle |
|---|---|
| `fichiers-importes/` | Médias importés quand la copie à l'import est activée |
| `enregistrements/` | Enregistrements micro |
| `voix-generees/` | Clips vocaux générés par XTTS |
| `images-generees/` | Images générées par ComfyUI et images éditées |
| `zips-extraits/` | Collections ZIP décompressées |
| `sauvegardes/` | Dossier de sauvegarde par défaut + versions de sécurité |
| `exports/` | Dossier de sortie suggéré pour les packs générés |

Les fichiers dans les dossiers médias gérés utilisent un préfixe
`{nom-du-projet}__` pour que plusieurs projets puissent partager le même
espace de travail sans risque.

Quand Story Studio te propose de supprimer un média du disque, il ne
supprime que les fichiers à l'intérieur des dossiers médias gérés de
l'espace de travail. Les fichiers sources externes ne sont retirés que de
la référence projet ou bibliothèque médias.

## Documentation

- [Guide d'installation XTTS](docs/guides/xtts-setup.fr.md)
- [Guide d'installation ComfyUI](docs/guides/comfyui-setup.fr.md)
- [Modèle de sécurité](SECURITY.md)
- [Mentions tierces](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)

> ℹ️ Les trois derniers documents (SECURITY, THIRD_PARTY_NOTICES, CHANGELOG) sont uniquement en anglais pour le moment.

## Roadmap

- Sortir de beta avec une v1 polish pour Windows.
- Passer en multi-plateforme (macOS et Linux).
- Rendre le logiciel compatible avec d'autres types de boîtes à histoires.

## Contribuer

Les contributions sont les bienvenues, en particulier :

- Rapports de bugs reproductibles.
- Notes de compatibilité pour les packs communautaires.
- Améliorations de la documentation.
- Pull requests ciblées avec des notes de test claires.

Merci de lire [CONTRIBUTING.md](CONTRIBUTING.md) avant d'ouvrir une pull
request.

## Sécurité

Story Studio est un éditeur de fichiers desktop local. Les fonctionnalités
optionnelles XTTS et ComfyUI se connectent à des services locaux configurés
par l'utilisateur.

Voir [SECURITY.md](SECURITY.md) pour le modèle de permissions et la
procédure de signalement des vulnérabilités.

## Licence

Le code source de Story Studio est sous licence [MIT](LICENSE).

Les binaires tiers embarqués et les assets tiers copiés restent sous leurs
licences respectives. Voir [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
