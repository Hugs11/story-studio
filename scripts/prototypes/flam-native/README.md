# Prototype jetable : inventaire et reprise sur FLAM

Ce second jalon ajoute une aventure originale, **La clé des lucioles** :
clairière, coffre, clé consommable, porte conditionnelle et fin explicite.
Il est séparé du transfert de production, sans framework tiers ni contenu commercial.

## État de validation

Le premier prototype **Le passage des lucioles** reste installé sous son identité
d’origine. L’utilisateur a confirmé sa lecture Audio B et son retour à l’écran
de départ sur le firmware 2.4.1.

**La sauvegarde durable du second prototype attend une validation sur la FLAM.**
Le harnais prouve les règles de partie et la restauration via un stockage simulé ;
il ne prouve pas la conservation des données par le firmware après extinction.

## Construire et vérifier

Prérequis : Python 3, cryptography, FFmpeg/ffprobe, Piper, une voix française et
Lua 5.4 pour les contrôles. Depuis la racine :

```sh
python scripts/prototypes/flam-native/prototype.py build --piper /chemin/vers/piper
python -m unittest discover -s scripts/prototypes/flam-native -p 'test_*.py'
lua scripts/prototypes/flam-native/check-runtime.lua
python -m py_compile scripts/prototypes/flam-native/*.py
luac -p scripts/prototypes/flam-native/passage.lua
luac -p scripts/prototypes/flam-native/scenes.lua
luac -p scripts/prototypes/flam-native/savegame.lua
```

La voix française installée par Story Studio est choisie par défaut ; un autre
modèle peut être passé avec --voice. L’option --piper peut être omise si
l’exécutable est dans le PATH.
Les quatre narrations sont originales et disponibles dans les fichiers texte.

Le résultat se trouve dans exports/flam-inventaire-prototype/ :
cle-des-lucioles.plain.pk, manifeste et aperçu de l’introduction.
Aucune métadonnée d’appareil n’est incluse dans cette archive de travail.

Le runtime utilise le profil Audio B : stéréo 44,1 kHz, 128 kbit/s, ID3/Xing et
table audio. Une narration propre à chaque scène est jouée à son entrée et relue
au début lors d’une reprise. La ressource mono de comparaison reste dans le pack mais n’est pas
sélectionnée par le runtime. Le succès antérieur de B n’établit pas la cause
exacte du silence initial, plusieurs caractéristiques ayant été modifiées.

## Comportements et sauvegarde

L’inventaire montre la quantité de clés. Le coffre ne donne sa clé qu’une fois.
L’ouverture consomme cette clé et conserve la porte ouverte. Sans clé, le choix
est désactivé avec une explication ; le retour vers la clairière reste possible.
Reprendre et recommencer sont distincts, avec confirmation avant un nouveau départ.

L’état sauvegardé est plat : version, scène, quantité, coffre vidé, porte ouverte.
Il exclut objets LVGL, fonctions et timers. Il n’écrit pas dans la globale
firmware state, dont certaines écritures ont provoqué des problèmes de relance
dans les expériences publiques.

Le seul adaptateur de stockage appelle progression.load/save avec le slot
lucioles, isolé par le firmware dans l’aventure. Chaque écriture est relue avant
confirmation. Cette relecture prouve un aller-retour de l’API, pas une résistance
à une coupure arbitraire pendant l’écriture flash. Les données restaurées sont
validées ; une sauvegarde inconnue n’est pas silencieusement remplacée.

Si une écriture a peut-être abouti mais que sa relecture échoue, l’écran
« Sauvegarde à vérifier » impose de relire la partie. Il ne propose pas une
annulation fictive d’une action potentiellement déjà persistée. L’annulation
reste disponible lorsque la relecture confirme que l’état précédent est intact.

La durée annoncée par le lecteur est vérifiée avant d’accepter une fin audio,
avec une tolérance d’une seconde. Une durée indisponible est signalée. Chaque
lecture possède un identifiant ; les callbacks d’une lecture quittée ne peuvent
pas terminer la narration suivante.

Le retour bibliothèque laisse un écran actif et conserve le module : le firmware
ne rappelle pas nécessairement setup. Consulter l’inventaire ne déplace pas le
point de reprise. Les récompenses ne sont pas liées au rendu ou à la réécoute.

## Contrôles locaux

Le point d’entrée convenu pilote le vrai runtime par la molette et les clics et
observe les textes affichés. L’hôte fournit seulement LVGL, l’audio et le stockage.

Les parcours couvrent le coffre, l’inventaire, la porte, les clics doublés, les
revisites, les quantités, la réouverture du même module et une nouvelle instance
avec sauvegarde conservée avant acquisition, avec clé puis après consommation.
Ils couvrent aussi la confirmation du nouveau départ, l’annulation, les erreurs
de lecture, les versions inconnues, les écritures refusées ou sans effet et les
régressions audio. Un stockage témoin d’une autre aventure reste intact.

Les tests Python utilisent un volume synthétique : intégrité, préservation des
autres histoires, refus des remplacements et annulation du transfert interrompu.
Ils ne réimplémentent pas les règles de l’aventure.

## Installer et retirer

Fermer l’application officielle pendant le transfert. Aucun montage automatique
ni changement de firmware n’est effectué.

```sh
python scripts/prototypes/flam-native/prototype.py install --device /chemin/FLAM
python scripts/prototypes/flam-native/prototype.py remove --device /chemin/FLAM
```

Ce prototype a un nouvel UUID, différent de celui du premier essai. L’installateur
reste limité aux métadonnées 2.4.1/2.4.2 et refuse une identité déjà installée.
Les fichiers autorisés incluent explicitement modules et narrations.
Liste et cache sont sauvegardés dans un répertoire privé sous
~/.local/share/com.hugs11.story-studio/flam-prototype/.
Les clés sont utilisées en mémoire, jamais affichées ni enregistrées dans le dépôt.

Le retrait vérifie les fichiers appartenant à ce prototype ; les autres histoires
et leurs sauvegardes ne sont pas supprimées. Démonter proprement avant déconnexion.
Après installation, éteindre complètement puis rallumer pour charger le nouveau code.

## Parcours matériel à confirmer

1. Désactiver le Wi-Fi, ouvrir **La clé des lucioles**, commencer et écouter.
2. Visiter la porte sans clé : ouverture indisponible, retour possible.
3. Explorer le coffre, prendre la clé, consulter l’inventaire : **Clé : 1**.
4. Quitter vers la bibliothèque puis reprendre : clé présente et coffre vide.
5. Éteindre complètement, rallumer, reprendre : même scène et même inventaire.
6. Ouvrir la porte : clé consommée et porte ouverte.
7. Éteindre, rallumer et reprendre : porte ouverte et **Clé : 0**.
8. Revisiter le coffre : aucune nouvelle clé ; traverser pour atteindre la fin.
9. Recommencer explicitement : inventaire vide, coffre plein et porte fermée.
10. Vérifier l’accès au premier prototype et aux histoires achetées.

Noter toute erreur avec son libellé et l’étape. Le ticket reste ouvert tant que
la conservation réelle après extinction n’est pas confirmée. Ce jalon ne valide
ni dés ni classes et n’intègre pas encore l’éditeur visuel.

## Sources d’interopérabilité

- [Expériences matérielles](https://github.com/o-daneel/Flam.RE/issues/1).
- [Chiffrement figé](https://github.com/Yariminal/flam-re/blob/2fb9033fb6566c010f6b34858242276dec2db7e8/docs/fw2-key-wrap.md).
- [API hôte](https://github.com/scarlaty/flam-player/blob/71385ff7812987e54fe843cd62c952d1246afd89/skills/flam-homebrew/references/lua-api.md).
- [Usage des API de progression](https://github.com/scarlaty/flam-player/blob/71385ff7812987e54fe843cd62c952d1246afd89/skills/flam-homebrew/assets/runtime/script/progressionManager.lua).
