# Prototype jetable : une aventure Lua sur FLAM

Question : une création Lua native originale peut-elle être lue sur la FLAM
2.4.1 connectée, avec audio, deux choix et retour à la bibliothèque ?

L’aventure **Le passage des lucioles** contient une narration française originale,
deux chemins et une fin différente selon le choix. Aucun inventaire, dé ou état
persistant n’est implémenté. Un échec de chargement audio est affiché explicitement.

## Diagnostic matériel, version 2

Premier retour utilisateur sur la version 1 : un clic sonore sans narration ;
après retour à la bibliothèque, réouverture sur la même fin. Le MP3 installé
était identique au pack et sa voix se décodait sur ordinateur.

Le second problème est reproduit dans `check-runtime.lua` : le firmware conserve
le module Lua à la réouverture, sans rappeler `setup()`. Le retour bibliothèque
prépare désormais un écran de départ actif, sans détruire les objets ni le timer.
La narration démarre par un clic explicite et ne joue pas derrière la bibliothèque.

Pour isoler le son, l’écran **Lucioles - diagnostic 2** propose deux profils :

- **B, stéréo**, sélectionné par défaut : même narration réencodée en stéréo avec
  en-têtes ID3/Xing ; sa table audio est régénérée.
- **A, mono original** : MP3 et table conservés octet pour octet de la première
  version. La molette change le profil avant de cliquer pour lancer la narration.

Pendant le test, les dernières lignes montrent le volume `V`, l’état du lecteur,
le retour de chargement `L`, le dernier événement `E` et la dernière seconde de
lecture signalée `t`. Ces observations servent à séparer un problème de format,
de chargement ou de lecture. Un arrêt pendant `audio.load` n’est plus interprété
comme une narration terminée. Un arrêt prématuré est affiché ; un clic permet
alors de tester les branches sans prétendre que l’audio fonctionne.

**Résultat matériel de la version 2 :** l’utilisateur confirme que tout fonctionne
avec **Audio B**, ainsi que le retour à l’écran de départ, sur sa FLAM 2.4.1.
Le profil B est donc la référence pour la suite. Le profil A n’a pas reçu de
validation positive distincte. Cet essai ne permet pas d’attribuer le silence
initial à un facteur précis : canaux, en-têtes, table audio ou séquencement des
événements ont besoin d’une comparaison isolée pour établir cette causalité.

Après remplacement des fichiers, **éteindre complètement puis rallumer la FLAM**
pour éviter de reprendre l’ancien module toujours en mémoire.

Le code Lua appelle directement les API hôtes documentées ; aucun framework
communautaire ni fichier d’une histoire commerciale n’est embarqué.

## Construire

Prérequis : Python 3, `cryptography`, FFmpeg/ffprobe, Piper et une voix française.
L’analyse syntaxique et le contrôle de parcours nécessitent Lua 5.4.

Depuis la racine du dépôt :

```sh
python scripts/prototypes/flam-native/prototype.py build \
  --piper /chemin/vers/piper \
  --voice /chemin/vers/fr_FR-siwis-medium.onnx
```

La voix installée par Story Studio est choisie par défaut. `--piper` est facultatif
si l’exécutable est dans le `PATH`. Le résultat se trouve dans
`exports/flam-native-prototype/` : archive de travail `.plain.pk` et manifeste.
Cette archive contient les sources et l’audio, sans métadonnées d’appareil.

## Vérifier localement

```sh
python -m unittest discover -s scripts/prototypes/flam-native -p 'test_*.py'
lua scripts/prototypes/flam-native/check-runtime.lua
luac -p scripts/prototypes/flam-native/main.lua
luac -p scripts/prototypes/flam-native/passage.lua
```

Les tests vérifient la publication et son annulation sur un volume synthétique,
la conservation des autres histoires, le refus d’un remplacement et les deux
parcours Lua sur hôte factice. Ils ne valident ni LVGL réel ni la lecture matérielle.
La table `.mp3map` est générée à partir des trames mesurées par ffprobe ; son
fonctionnement sur le firmware reste inclus dans l’essai matériel.

## Installer et retirer

L’application officielle doit être fermée pendant le transfert. Utiliser le point
de montage de la FLAM ; aucun montage automatique n’est effectué.

```sh
python scripts/prototypes/flam-native/prototype.py install --device /chemin/FLAM
python scripts/prototypes/flam-native/prototype.py remove --device /chemin/FLAM
```

L’installateur est limité à ce prototype et aux métadonnées des firmwares 2.4.1 et
2.4.2. L’UUID est fixe et propre à cette expérience. Une installation existante
est refusée. Les scripts et `info` sont chiffrés en mémoire ; les clés ne sont
jamais affichées ni enregistrées dans le dépôt. L’installateur relit chaque
fichier publié et vérifie le déchiffrement des scripts avant inscription dans la
liste. La liste et le cache sont sauvegardés dans un répertoire privé sous
`~/.local/share/com.hugs11.story-studio/flam-prototype/`.

La liste conserve ses entrées existantes et reçoit l’UUID du prototype ; le cache
est invalidé pour être reconstruit par le firmware. Les autres histoires et les
métadonnées de l’appareil ne sont pas modifiées. La commande de retrait vérifie
les empreintes des fichiers du prototype avant suppression et conserve les
autres entrées de la bibliothèque, même ajoutées après l’installation.

Après transfert, démonter proprement le volume avant de débrancher l’USB.

## Validation sur l’appareil

1. Après extinction/rallumage, ouvrir **Le passage des lucioles** et vérifier que
   l’écran indique **Lucioles - diagnostic 2**.
2. Laisser **Audio B : stéréo**, cliquer et écouter la narration entière,
   environ 16 secondes. En cas de silence, noter les valeurs `V`, état, `L`, `E`, `t`.
3. Tourner la molette et cliquer : vérifier la fin du pont, puis revenir à la bibliothèque.
4. Relancer : l’écran de départ doit revenir. Cliquer, choisir le sentier et vérifier son autre fin.
5. Relancer encore et tester le bouton retour.
6. Comparer avec **Audio A : mono original** depuis l’écran de départ si nécessaire.
7. Éteindre puis rallumer et refaire une lecture avec le Wi-Fi désactivé.

Un écran noir, un titre illisible, l’absence d’audio ou une relance bloquée ne
constituent pas une validation : noter l’étape et ce qui est affiché. Aucun
changement de firmware n’est nécessaire à cet essai.

Le rapport local `exports/flam-native-prototype/validation.json` distingue les
vérifications de transfert de la lecture réelle confirmée par l’utilisateur.
Les essais d’inventaire, de dés et de sauvegarde durable ne font pas partie de
cette validation. Le test spécifique Wi-Fi désactivé n’a pas été confirmé séparément.

## Sources d’interopérabilité

- [Expériences primaires sur firmware 2.4.2](https://github.com/o-daneel/Flam.RE/issues/1).
- [Recette de chiffrement figée](https://github.com/Yariminal/flam-re/blob/2fb9033fb6566c010f6b34858242276dec2db7e8/docs/fw2-key-wrap.md).
- [API hôte et événements molette](https://github.com/scarlaty/flam-player/blob/71385ff7812987e54fe843cd62c952d1246afd89/skills/flam-homebrew/references/lua-api.md).
- [Format de la table audio](https://github.com/scarlaty/flam-player/blob/71385ff7812987e54fe843cd62c952d1246afd89/src/formats/mp3map_parser.c).

Le comportement observé par ces auteurs en 2.4.2 a servi de piste ; la validation
de notre prototype en 2.4.1 vient du retour utilisateur sur la version 2 et son
profil B. Ce code expérimental ne modifie pas le transfert de production, qui
continue à refuser les écritures FLAM.
