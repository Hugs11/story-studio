> [🇬🇧 English](README.md) | 🇫🇷 **Français**

<p align="center">
  <img src="public/logostory.svg" alt="Story Studio" width="240">
</p>

<p align="center">
  Éditeur desktop moderne pour créer, agréger, tester et générer des packs d'histoires compatibles Lunii.
</p>

<p align="center">
  <a href=".github/workflows/ci.yml"><img alt="CI : builds desktop" src="https://img.shields.io/badge/CI-builds%20desktop-2ea44f.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="#configuration-requise"><img alt="Plateformes : Windows, Linux et macOS" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-0078D4.svg"></a>
  <a href="CHANGELOG.md"><img alt="Version 0.9.9" src="https://img.shields.io/badge/version-0.9.9-2F80ED.svg"></a>
  <a href="#statut-bêta"><img alt="Statut : bêta" src="https://img.shields.io/badge/statut-b%C3%AAta-f59e0b.svg"></a>
  <a href="https://tauri.app/"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB.svg"></a>
  <a href="https://react.dev/"><img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB.svg"></a>
</p>

Story Studio est un logiciel pour créer et modifier des packs pour les boîtes à histoires Lunii.
Il intègre des outils pour éditer le son et les images, et évite de devoir jongler avec Audacity
ou d'autres logiciels pour créer son pack d'histoires.
Tout reste local : images, audio, navigation, simulation et génération du ZIP.

Deux éditeurs permettent d'adapter l'espace de travail au projet :

- l'**Éditeur par menus** organise simplement les Dossiers et les Histoires sous forme d'arborescence ;
- l'**[Éditeur graphe](https://hugs11.github.io/story-studio/docs/editeur-graphe/)** donne accès aux Écrans, aux Listes de choix et à tous leurs raccords pour créer des histoires à choix multiples, des quiz ou des parcours croisés.

Pour une histoire unique, l'**Éditeur simplifié** propose un point de départ plus guidé.

Importe tes médias, assemble et découpe l'audio, recadre les images,
organise tes menus et tes récits, puis génère un ZIP compatible Lunii sans
jongler entre plusieurs outils.

> Story Studio est un outil communautaire. Il n'est pas affilié à Lunii, ni
> soutenu ou sponsorisé par Lunii.

> **Story Studio est conçu et développé avec l'aide d'outils d'intelligence artificielle. Les choix de conception, la direction du projet et la validation finale reviennent à un humain.**

## Statut bêta

Story Studio est actuellement en bêta. L'app est utilisable, mais elle peut
encore contenir des bugs, des cas limites et des problèmes de compatibilité
avec certains packs communautaires. Garde des copies de sauvegarde de tes
projets importants et signale les problèmes reproductibles via les GitHub
issues.

> ### Rejoindre la communauté sur Discord
>
> Une idée pour Story Studio, un bug à éclaircir rapidement, envie d'accéder
> aux versions bêta ou simplement besoin d'aide ?
> [Rejoins le serveur Discord de Story Studio](https://discord.gg/jztpQz5Ad)
> pour échanger directement avec les utilisateurs et le développement du projet.

## Dernière version

Story Studio 0.9.9 introduit l'**Éditeur graphe**, capable de reprendre et de
modifier directement les navigations avancées. Lorsqu'un pack convient aux
deux éditeurs, Story Studio te laisse choisir ; lorsque sa structure ne rentre pas
dans un arbre hiérarchique, il s'ouvre directement dans le graphe. Tu peux aussi
copier un projet de l'Éditeur par menus dans l'Éditeur graphe ; l'original reste intact.

Cette version ajoute des contrôles avant la génération du ZIP et rend plus fiables l'import,
le Simulateur, les sauvegardes et les outils communs aux deux éditeurs.

- [Télécharger la dernière version](https://github.com/Hugs11/story-studio/releases/latest)
- [Lire les notes de version 0.9.9](https://github.com/Hugs11/story-studio/releases/tag/v0.9.9)
- [Voir le changelog complet](CHANGELOG.md)

## Packs de démonstration

Découvre Story Studio avec deux packs prêts à ouvrir, parcourir dans le
Simulateur et adapter dans l'éditeur :

<table>
  <tr>
    <td align="center" width="50%">
      <a href="https://drive.proton.me/urls/5ND49D487R#IxRa3Bd0Lm8L"><img src="docs/public/assets/demo-packs/leo-la-licorne.png" width="130" alt="Couverture de Léo la licorne"></a><br>
      <strong>Léo la licorne</strong><br>
      <a href="https://drive.proton.me/urls/5ND49D487R#IxRa3Bd0Lm8L">Télécharger sur Proton Drive</a>
    </td>
    <td align="center" width="50%">
      <a href="https://drive.proton.me/urls/H7ZTBC8S14#aj2WBn39jDRF"><img src="docs/public/assets/demo-packs/toudou-cache-cache.png" width="130" alt="Couverture de Toudou mon doudou et Cache-Cache"></a><br>
      <strong>Toudou mon doudou + Cache-Cache — intégrale</strong><br>
      <a href="https://drive.proton.me/urls/H7ZTBC8S14#aj2WBn39jDRF">Télécharger sur Proton Drive</a>
    </td>
  </tr>
</table>

Pour découvrir un pack dans Story Studio :

1. Télécharge son fichier ZIP depuis Proton Drive.
2. Lance Story Studio et clique sur **Modifier un pack existant**.
3. Sélectionne le fichier `.zip` téléchargé.

Ces packs sont distribués séparément du logiciel. Leurs histoires, fichiers
audio et illustrations ne sont pas couverts par la licence MIT de Story Studio.

## En un coup d'œil

| | |
|---|---|
| **Statut** | Bêta |
| **Plateformes cibles** | Windows x64, Linux x86_64 et macOS Apple Silicon |
| **Format projet** | `.mbah` |
| **Format de génération** | Packs ZIP compatibles Lunii |
| **Stack principale** | React 19, Vite, Tauri 2, Rust |
| **Workflow** | Accueil guidé, Éditeur par menus, Éditeur graphe, agrégation de packs ZIP, Bibliothèque médias, Simulateur et génération du ZIP contrôlée |
| **Vie privée** | App locale, aucun backend hébergé, aucune télémétrie |

## Du premier import au pack prêt à jouer

Story Studio rassemble tout le parcours dans une application locale : partir
de ses propres fichiers ou d'un pack existant, préparer les médias, construire
la navigation, tester le résultat et générer un pack prêt pour la boîte à
histoires.

### 1. Démarrer un projet ou importer des histoires

Crée selon tes envies, reprends un travail enregistré, modifie un pack ZIP/7z
existant ou pars d'un podcast ou de YouTube. Des parcours guidés
permettent aussi d'agréger plusieurs packs ou d'analyser un pack communautaire.

![Accueil de Story Studio avec les trois éditeurs et les parcours guidés](docs/public/assets/screenshots/home-dark.png)

### 2. Préparer les fichiers audio

Importe ou enregistre un son, puis ajuste-le avant de l'utiliser dans une
histoire. Un enregistrement long peut être découpé en extraits réutilisables ;
plusieurs fichiers peuvent aussi être réordonnés et assemblés en une seule piste
sans modifier les originaux.

![Édition précise d'une forme d'onde dans Story Studio](docs/public/assets/screenshots/audio-editor-dark.png)

| Découper un enregistrement en extraits | Assembler plusieurs fichiers en une piste |
|---|---|
| ![Découpe audio avec plusieurs extraits préparés](docs/public/assets/screenshots/Audio-decoupe-light.png) | ![Assemblage audio avec des sources réordonnables](docs/public/assets/screenshots/Audio-assemble-light.png) |

### 3. Créer les voix, générer les illustrations et adapter les images

Génère des voix localement avec Piper, prêt à l'emploi, ou utilise XTTS pour
le clonage vocal avancé. ComfyUI peut produire des illustrations via un service
local ; les tâches vocales et visuelles restent suivies dans les files de
génération de Story Studio.

| Générer une voix localement avec Piper ou XTTS | Générer une illustration avec ComfyUI |
|---|---|
| ![Génération vocale locale avec Piper](docs/public/assets/screenshots/voice-generation-dark.png) | ![Génération d'une illustration avec un workflow ComfyUI](docs/public/assets/screenshots/comfyui-generation-dark.png) |

Les images peuvent ensuite être recadrées, redimensionnées et ajustées au
format 320×240 de la boîte à histoires.

![Recadrage et ajustement d'une image pour la boîte à histoires](docs/public/assets/screenshots/image-editor-dark.png)

### 4. Construire et tester la navigation

Avec l'**Éditeur par menus**, construis une arborescence de Dossiers et
d'Histoires, attribue leurs images et leurs sons, puis définis le rôle des
boutons pendant et après la lecture. Le Diagramme permet de relire le parcours
obtenu sans perdre l'organisation par niveaux.

![Espace unifié avec l'arbre, les réglages de l'histoire et le Diagramme](docs/public/assets/screenshots/workspace-dark.png)

Avec l'**Éditeur graphe**, travaille directement sur les Écrans, les Listes de
choix et leurs raccords. Il permet de construire des choix multiples, des quiz,
des tirages aléatoires et des parcours qui réutilisent les mêmes Écrans à
plusieurs endroits.

![Vue générale de l'Éditeur graphe avec la liste des nœuds et l'Inspecteur](docs/public/assets/screenshots/graph-editor-overview-dark.png)

Les deux éditeurs partagent la Bibliothèque médias, les outils audio, la file de rendu
et le même Simulateur flottant. Tu peux parcourir la navigation avant
la génération du ZIP comme sur la boîte à histoires.

![Diagramme complet du projet testé dans le Simulateur intégré](docs/public/assets/screenshots/diagram-simulator-dark.png)

### 5. Vérifier les réglages et générer le ZIP

Contrôle les métadonnées publiques, la Vignette catalogue, le nom du fichier
et les options audio ou de navigation du pack. Story Studio vérifie la
structure, l'identité et les médias, puis relit le ZIP produit avant de terminer
la génération du ZIP.

![Métadonnées du pack avec la Vignette catalogue, l'UUID et le nom du ZIP](docs/public/assets/screenshots/pack-metadata-dark.png)

![Réglages audio et navigation du pack](docs/public/assets/screenshots/Pack-settings.png)

Les packs communautaires existants peuvent également être analysés séparément.
Le vérificateur regroupe les problèmes de structure, d'image et d'audio,
propose des corrections sûres et peut exporter un rapport détaillé.

![Vérificateur de pack communautaire et corrections proposées](docs/public/assets/screenshots/pack-checker-dark.png)

## Fonctionnalités

- **Éditeur par menus** avec Dossiers, Histoires, menus imbriqués, multi-sélection, glisser-déposer et Diagramme.
- **Éditeur graphe** avec Écrans, Listes de choix, raccords, sélection multiple, presse-papier et disposition automatique.
- **Flux guidés depuis l'accueil** pour modifier un pack existant, créer depuis un podcast ou YouTube, agréger des ZIP et vérifier/corriger un pack communautaire.
- **Import de packs ZIP Lunii** : choix entre les deux éditeurs lorsque c'est possible, ouverture des structures complexes dans le graphe et sélection d'un pack dans les archives qui en contiennent plusieurs.
- **Workflow audio intégré** : enregistrement micro, rognage, coupes, fondus, assemblage et insertion de silence.
- **Workflow image intégré** : recadrage 320×240 automatique, génération d'images textuelles depuis les noms.
- **Génération vocale locale** avec Piper par défaut et XTTS en option avancée.
- **Bibliothèque médias** avec tags, filtres, compteurs d'utilisation et aperçus rapides.
- **Simulateur intégré** pour tester la navigation et les nœuds de fin avant génération du ZIP.
- **Validation et file de rendu** : vérifications de compatibilité et génération en série avec suivi des logs.
- **Intégrations locales optionnelles** : YouTube via yt-dlp, XTTS (voix) et ComfyUI (images).
- **Confort projet** : sessions non enregistrées, enregistrement automatique, reprise après crash, versions de sécurité, raccourcis configurables, thèmes clair/sombre, vue Diagramme.

## Pourquoi Story Studio ?

Je cherchais un outil simple pour créer des histoires audio pour mon enfant. En
tant qu'ancien monteur vidéo, je ne retrouvais pas dans les outils existants ce
qui me semblait essentiel : une interface visuelle, directe et fluide,
permettant de construire une narration sans friction, sans ligne de commande ni
structures de dossiers complexes.

Story Studio est né de ce besoin : rassembler l'import, les images, l'audio, la
navigation, la simulation et la génération du ZIP dans un même espace clair, local et
compréhensible.

## Configuration requise

| Plateforme | Prérequis et limites |
|---|---|
| Windows x64 | Windows 10 ou plus récent avec WebView2 |
| Linux x86_64 | Distribution basée sur glibc avec WebKitGTK 4.1 et les codecs GStreamer usuels ; paquets AppImage, DEB et RPM disponibles |
| macOS Apple Silicon | macOS 11 ou plus récent sur Mac M1 ou ultérieur ; les Mac Intel ne sont pas pris en charge |

Les binaires tiers embarqués conservent leurs licences et une provenance
épinglée — voir [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) et
[l'offre de sources correspondantes](THIRD_PARTY_SOURCE_OFFER.md).

## Installation

Télécharge le paquet adapté à ta plateforme depuis la
[page GitHub Releases](https://github.com/Hugs11/story-studio/releases/latest) :

- **Windows x64 :** utilise l'installeur EXE, ou le paquet MSI pour un
  déploiement administré.
- **AppImage :** rends le fichier exécutable avec
  `chmod +x Story-Studio*.AppImage`, puis lance-le.
- **Debian/Ubuntu :** installe le DEB téléchargé avec
  `sudo apt install ./Story-Studio*.deb`.
- **Fedora :** installe le RPM téléchargé avec
  `sudo dnf install ./Story-Studio*.rpm`.
- **macOS Apple Silicon :** ouvre le DMG, glisse Story Studio dans
  Applications, puis lance l'app.

Le build macOS n'a pas de certificat Developer ID et n'est pas notarisé.
Gatekeeper peut donc bloquer le premier lancement. Dans Finder, fais un
Contrôle-clic sur l'app puis choisis **Ouvrir**, ou utilise
**Réglages Système → Confidentialité et sécurité → Ouvrir quand même**.
Ne désactive pas Gatekeeper globalement.

Les intégrations IA sont optionnelles. XTTS a été testé sous Linux en mode CPU ;
le mode GPU n'a pas été validé pour la 0.9.9. ComfyUI est validé manuellement uniquement sous
Windows : les tests manuels Linux n'ont pas été exécutés.

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

Les données applicatives sont stockées dans
`%LOCALAPPDATA%\com.hugs11.story-studio` sous Windows,
`${XDG_DATA_HOME:-~/.local/share}/com.hugs11.story-studio` sous Linux et
`~/Library/Application Support/com.hugs11.story-studio` sous macOS.
Les fichiers choisis par l'utilisateur restent accessibles hors de ces
dossiers, y compris sur les volumes macOS externes sous `/Volumes`.

Quand Story Studio te propose de supprimer un média du disque, il ne
supprime que les fichiers à l'intérieur des dossiers médias gérés de
l'espace de travail. Les fichiers rangés ailleurs sont seulement retirés du projet ou de la
Bibliothèque médias, jamais supprimés du disque.

## Documentation

- [Documentation utilisateur en français](https://hugs11.github.io/story-studio/docs/)
- [Voix locales : Piper et XTTS](https://hugs11.github.io/story-studio/docs/voix-locales-piper-xtts/)
- [Configurer ComfyUI](https://hugs11.github.io/story-studio/docs/comfyui/)
- [Modèle de sécurité](SECURITY.md)
- [Mentions tierces](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)

> ℹ️ Les trois derniers documents (SECURITY, THIRD_PARTY_NOTICES, CHANGELOG) sont uniquement en anglais pour le moment.

## Roadmap

- Finaliser et valider les paquets Windows x64, Linux x86_64 et macOS Apple Silicon.
- Sortir de la bêta avec une v1 finalisée.
- Rendre le logiciel compatible avec d'autres types de boîtes à histoires.

## Contribuer

Les contributions sont les bienvenues, en particulier :

- Rapports de bugs reproductibles.
- Notes de compatibilité pour les packs communautaires.
- Améliorations de la documentation.
- Pull requests ciblées avec des notes de test claires.

Pour discuter d'une idée avant d'ouvrir une issue ou partager rapidement un
retour de bêta-test, tu peux aussi rejoindre le
[serveur Discord de Story Studio](https://discord.gg/jztpQz5Ad).

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
