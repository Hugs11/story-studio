# FLAM : export brut et récupération du contenu officiel

Recherche documentaire du **14 novembre 2026**. Aucun accès au FLAM, au compte, aux secrets ou aux répertoires personnels de l’application. Aucun logiciel Lunii exécuté, aucune implémentation. Inspection statique de code public et de binaires officiels téléchargés dans `/tmp`.

**Conclusion : la sauvegarde brute est documentée ; la lecture/édition locale des histoires officielles reste conditionnée par l’obtention du contenu clair ou de sa clé effective. Un échec de comparaison dans Lunii.QT ne démontre aucune impossibilité générale de récupération. Le client officiel possède un chemin public de téléchargement/export vers l’appareil, mais le chemin inspecté transporte les fichiers sans déchiffrer les histoires.**

## Ce qu’établit Lunii.QT

Source tierce, primaire pour son propre comportement, **pas une spécification officielle Lunii**. Le [fichier demandé sur `main`](https://raw.githubusercontent.com/o-daneel/Lunii.QT/main/pkg/api/device_flam.py) a été lu puis comparé à la [révision figée `c8afe43`](https://github.com/o-daneel/Lunii.QT/blob/c8afe43dde21c2be33c0667ced962dc023eb948a/pkg/api/device_flam.py) : identique lors de la recherche.

- `export_story` accepte `key == self.keyfile`, sinon un `bt` fournissant 16 octets de clé et 16 d’IV ; sinon il appelle `export_backup_story`, qui archive les fichiers inchangés, `key` compris.
- L’export natif déchiffre `info` et les `.lsf`, renommés `.lua`, et omet `key`/`bt`. Les autres ressources sont copiées. Le format à index utilise une branche distincte, limitée aux premiers 512 octets des ressources concernées.
- `__mdf_parse` traite différemment les firmwares 1.x et suivants : valeurs dérivées du numéro de série ou lues à `0x4e`. Ces noms de variables ne prouvent pas leur rôle dans une installation officielle.
- **L’ouverture par `FlamDevice` modifie déjà l’index et supprime `library.cache`** : ne pas employer cette classe pour une simple inspection préservant l’original. [Code et fonctions concernés](https://github.com/o-daneel/Lunii.QT/blob/c8afe43dde21c2be33c0667ced962dc023eb948a/pkg/api/device_flam.py#L33).

L’auxiliaire utilise **AES-CBC**, avec bourrage nul lors du chiffrement. La détection « FLAM » repose sur la présence d’un `.lsf` : elle ne valide ni la clé ni l’exécution. Le nom `.lua` après export ne prouve donc pas, seul, qu’un script est intelligible ou compatible avec un lecteur local. [Implémentation `stories.py`, fonctions `aes_*` et `story_is_*`](https://github.com/o-daneel/Lunii.QT/blob/c8afe43dde21c2be33c0667ced962dc023eb948a/pkg/api/stories.py).

**Piste concrète, non généralisable :** l’auteur de la [PR #72](https://github.com/o-daneel/Lunii.QT/pull/72) rapporte un export réussi en empruntant le `bt` d’une histoire ayant exactement le même `key`. C’est un témoignage de première main avec proposition de code, pas une garantie pour tout compte/firmware. L’affirmation « même propriétaire ⇒ même clé » demande validation. La [fiche API de la PR](https://api.github.com/repos/o-daneel/Lunii.QT/pulls/72) indique une fermeture le 24 octobre 2026 **sans fusion** ; ce repli est absent de la révision analysée.

L’[issue #75](https://github.com/o-daneel/Lunii.QT/issues/75) rapporte sur firmware 1.x des histoires réimportées devenues injouables, puis une restauration réussie depuis le ZIP d’origine. Son hypothèse d’une clé enveloppée déballée par une clé en flash reste une **hypothèse du rapporteur**, non confirmée ici par le firmware. Le mainteneur reconnaît une possible erreur de rétrocompatibilité. Ne pas confondre réussite de l’export clair et possibilité de réimporter les modifications.

## Client officiel : chemin vérifié dans les binaires publics

Lunii documente la [synchronisation USB depuis l’application pour ordinateur](https://support.lunii.com/hc/fr/articles/14126987088541-Comment-transf%C3%A9rer-des-livres-audio-sur-FLAM), après connexion au compte et association de l’appareil. Cela confirme le transfert officiel, pas un export MP3 ni la disponibilité d’une clé claire.

Depuis la [page officielle des applications](https://lunii.com/fr-eu/application-lunii), le [lien Linux 64 bits](https://downloads.lunii.com/v1/luniistore-installers/ln-ins-default-linux-64-deb) redirigeait vers [l’installateur 4.1.312](https://statics.lunii.com/storage/public/deploy/installers/linux/64bits/lunii-4.1.312-amd64.deb). Inspection par `ar`, lecture des JAR avec `zipfile`, désassemblage par `javap -c -p` ; aucune installation.

Le paquet embarque `LauncherLoader-2.0.0.jar`. Son `UpdateLauncherService.getServerInfos()` consulte le [point public `/launcher`](https://server.lunii.com/launcher), qui désignait [le lanceur 2.0.9](https://storage.googleapis.com/storage.lunii.fr/public/deploy/luniistore-launcher-2.0.9.jar). Celui-ci charge un manifeste `app.json` et les JAR applicatifs. Le [manifeste public inspecté](https://storage.googleapis.com/storage.lunii.fr/public/deploy/last/app.json) inclut notamment :

| Artefact officiel | Observation statique vérifiée |
| --- | --- |
| [`lunii-luniistore-sdk.jar`](https://storage.googleapis.com/storage.lunii.fr/public/deploy/last/lunii-luniistore-sdk.jar) | `BackendDeviceRepository.getAudioBook(serial, uuid)` construit un GET relatif `devices/{serial}/audiobooks/{uuid}`. `GetAudioBookResponse` expose notamment `url` et `bt`. Aucune requête à cet endpoint de compte n’a été faite. |
| [`lunii-luniistore-data.jar`](https://storage.googleapis.com/storage.lunii.fr/public/deploy/last/lunii-luniistore-data.jar) | `FlamSynchronizationTask.downloadAudiobook()` télécharge `getUrl()` dans un répertoire temporaire `audiobook…`, sous le nom UUID. Il décode `getBt()` avec `Base64.getUrlDecoder()` et écrit `<uuid>.key`. |
| Même JAR, `installAudiobook()` | Lit l’archive avec `TarInputStream`, copie ses entrées par flux vers le répertoire d’installation temporaire de l’appareil, accepte `main.lsf` ou `ni`, copie `<uuid>.key` vers `key`, puis renomme le répertoire. Aucun déballage cryptographique de clé ni déchiffrement de contenu dans cette méthode. |
| [`lunii-java-util.jar`](https://storage.googleapis.com/storage.lunii.fr/public/deploy/last/lunii-java-util.jar) | `DownloadTask` lit la réponse HTTP et écrit les octets par `RandomAccessFile` ; aucun déchiffrement de contenu dans ce chemin. |
| [`lunii-device-gateway.jar`](https://storage.googleapis.com/storage.lunii.fr/public/deploy/last/lunii-device-gateway.jar) | `FlamMetadataFile.readV1()` lit 48 octets à partir de `0x4e`, nommés `challengeToken`, après firmware, série et VID/PID. Ce client ne les présente pas comme une clé AES claire. |

**Distinction décisive :** le `bt` de la réponse officielle est ici écrit comme fichier **`key`**, alors que Lunii.QT interprète un fichier nommé **`bt`** comme clé/IV directement utilisables. Le même nom ne prouve pas la même sémantique. Base64 est un encodage ; le décoder ne démontre pas un déballage de clé. La nature exacte des octets fournis par le serveur reste **non vérifiée**, faute de réponse réelle analysée.

Le lanceur stocke ses JAR sous `Luniitheque/lib` (`resolveCacheDir`) : **cache de code**, pas preuve d’un cache audio clair. Les emplacements de `Luniitheque` sont aussi [documentés officiellement](https://support.lunii.com/hc/fr/articles/4417848663569-Configurer-l-application-Lunii-pour-ordinateur-pour-qu-elle-se-connecte-via-un-serveur-proxy) : Linux `~/.local/share/Luniitheque/`, Windows `%AppData%/Luniitheque/`, macOS `~/Library/Application Support/Luniitheque/`. Aucun de ces dossiers locaux n’a été consulté. Le chemin FLAM inspecté supprime son répertoire temporaire après synchronisation, y compris lors de l’exception encadrée : **ne pas compter sur un cache permanent de téléchargement**. [Lanceur](https://storage.googleapis.com/storage.lunii.fr/public/deploy/luniistore-launcher-2.0.9.jar), [synchronisation](https://storage.googleapis.com/storage.lunii.fr/public/deploy/last/lunii-luniistore-data.jar).

## Faisabilité et prochaines étapes proposées

Ces étapes sont des pistes, **aucune n’a été exécutée sur les données de l’utilisateur**.

1. **Préserver un export brut complet**, avec `key`, arborescence et métadonnées d’origine, avant toute conversion. Il permet l’analyse ultérieure ; il ne constitue pas une archive portable déchiffrée. Travailler ensuite sur une copie isolée, sans lancer le gestionnaire sur l’original. La politique de sauvegarde sur l’appareil d’origine est aussi explicitée dans le [README de Lunii.QT](https://github.com/o-daneel/Lunii.QT/blob/c8afe43dde21c2be33c0667ced962dc023eb948a/README.md).
2. **Chercher du matériel de déchiffrement déjà disponible** : sur une copie ultérieurement autorisée, vérifier un éventuel `bt` existant et la piste d’une histoire sœur à `key` identique. Valider sur plusieurs fichiers structurés, pas sur la seule taille ou une égalité de noms. Blocage : aucun `bt` compatible n’est établi pour ce FLAM. [PR #72](https://github.com/o-daneel/Lunii.QT/pull/72).
3. **Poursuivre l’analyse statique du client public** : rechercher les autres chemins de cache, lecture, conversion et appels cryptographiques ; retracer une éventuelle routine de déballage jusqu’à sa source de clé. Le chemin USB identifié fournit déjà archive et enveloppe, **sans nécessiter de casser AES**, mais ne révèle pas de clé claire. Si le déballage est réservé au firmware, ce chemin PC seul ne suffira pas. C’est une incertitude à résoudre, pas une impossibilité acquise. [JAR de synchronisation](https://storage.googleapis.com/storage.lunii.fr/public/deploy/last/lunii-luniistore-data.jar), [SDK](https://storage.googleapis.com/storage.lunii.fr/public/deploy/last/lunii-luniistore-sdk.jar).
4. **Observation dynamique éventuelle, hors périmètre actuel** : seulement sur un environnement et des données expressément autorisés, distinguer téléchargement chiffré, enveloppe serveur et clé réellement utilisée. Le support d’un proxy est documenté, mais ne prouve ni visibilité du contenu HTTPS ni présence d’une clé claire. Un dump mémoire ou de journaux n’est pas nécessaire à cette recherche documentaire et n’a pas été effectué. [Documentation proxy](https://support.lunii.com/hc/fr/articles/4417848663569-Configurer-l-application-Lunii-pour-ordinateur-pour-qu-elle-se-connecte-via-un-serveur-proxy).
5. **Lecture et édition sont deux étapes supplémentaires** : examiner séparément les ressources audio éventuellement déjà lisibles, puis le scénario et son environnement d’exécution. Pour le format natif, déchiffrer les scripts ne fournit pas automatiquement une machine d’exécution FLAM. Pour réimporter, il faut en plus préserver une autorisation et un chiffrement acceptés par le firmware. [Auxiliaires de format](https://github.com/o-daneel/Lunii.QT/blob/c8afe43dde21c2be33c0667ced962dc023eb948a/pkg/api/stories.py), [retour d’expérience #75](https://github.com/o-daneel/Lunii.QT/issues/75).

**Cryptanalyse :** aucune attaque de récupération de clé n’est démontrée par les sources examinées. **Récupération côté logiciel :** caches, clé/IV déjà disponibles et routines de déballage sont des questions différentes, encore partiellement ouvertes. Rien ne permet d’affirmer que l’application officielle possède nécessairement la clé effective : elle peut transporter du contenu préparé côté serveur.

**Fonctions officielles disponibles :** Mon Studio permet d’enregistrer et d’éditer ses propres histoires, puis de les transférer sur FLAM ; son « export » désigne l’envoi vers la bibliothèque du compte. La FAQ actuelle indique que l’import de fichiers audio préenregistrés n’est pas développé. Ce parcours ne constitue pas un export des histoires commerciales pour édition locale. [FAQ Studio](https://support.lunii.com/hc/fr/articles/360014473658-Tout-savoir-sur-Mon-Studio-Lunii), [compatibilité FLAM](https://support.lunii.com/hc/fr/articles/14116470821661-Mon-Studio-Lunii-est-il-compatible-avec-FLAM). L’ancienne [FAQ de 2023 sur le contenu externe](https://support.lunii.com/hc/fr/articles/11105675782301-Est-il-possible-d-ajouter-du-contenu-audio-externe-sur-FLAM) doit être lue avec cette évolution ; elle ne suffit pas à décrire les capacités actuelles du Studio.

## Traçabilité et limites

Sources officielles : assistance Lunii et artefacts distribués par ses lanceurs. Sources communautaires : code Lunii.QT et rapports de leurs auteurs, avec le niveau de certitude indiqué. Aucun dépôt de sources officiel complet de l’application n’a été identifié pendant cette recherche ; le bytecode public inspecté est une source primaire distribuée par Lunii, **pas une publication open source**. Audit limité aux classes citées, sans audit exhaustif des autres modules, firmware ou variantes Windows/macOS.

Les URL `/last/` sont mutables. Empreintes SHA-256 des artefacts effectivement analysés :

```text
lunii-4.1.312-amd64.deb   25613bea97d7e27175d4375748d54c853876d86bc3156b1b3e98d1bacb51b238
launcher-2.0.9.jar        b1d9a065af20011b994650816f43188fe263fd3f79143d04cee70a5932d0b63b
app.json                 5d63daf4c2d201266fdba9950d49fdb97528b41b10cb787a612437e8b312c83d
luniistore-data.jar      a3dad9ac05c272ba3ff5e247a15b8bace96829bba058c8d63976822e63532797
luniistore-sdk.jar       18b94618c75aaa2a587de5b37b25d7bf4fb4cb8640b4ef24cebcead78c94fdb7
device-gateway.jar       3a2223bb7eb6b3d5daf34d30fbbf342a695df0090aab5c77b8091a6f589dd283
```

Le firmware et les histoires de l’utilisateur n’ayant pas été examinés, aucune conclusion spécifique à leur version, à leurs clés ou à leur récupérabilité n’est possible à ce stade.

## Vérification locale complémentaire par l’agent principal

Cette section est distincte de la recherche documentaire ci-dessus. Lecture seule du FLAM monté et inspection statique de l’installation locale ; aucun appel au compte, aucun affichage de clé, aucune modification de l’appareil.

- Installation trouvée sous `/opt/Lunii`, modules sous `~/.local/share/Luniitheque/lib`. Le dossier local `packs` est vide au moment de la vérification.
- Inventaire local : trois histoires natives Lua et huit histoires à index. Les onze fichiers `key` sont distincts et aucun dossier d’histoire ne contient de fichier `bt`. Le repli de la PR #72 ne dispose donc pas actuellement d’une histoire sœur utilisable sur cet appareil.
- Échantillonnage borné des en-têtes de ressources : des fichiers ID3 sont présents dans les histoires natives. Un échantillon de chacune des trois histoires natives a été sondé par `ffprobe` : succès, flux audio `mp3`. Cela démontre que ces échantillons sont lisibles sans déchiffrement ; cela ne démontre ni l’intégrité de toutes les ressources ni la récupération du scénario interactif. Aucun audio n’a été copié ou reproduit.
- Désassemblage local de `FlamSynchronizationTask.downloadAudiobook` par `javap` : confirme le téléchargement de l’URL fournie par le serveur et l’écriture de `Base64.getUrlDecoder().decode(getBt())` dans le fichier `.key`. Ce chemin ne révèle pas de clé de contenu claire.
- Recherche statique de références cryptographiques Java usuelles dans les modules `lunii-*.jar` : aucune référence directe trouvée à `javax/crypto/Cipher`, `SecretKeySpec`, `AES/`, `decrypt`, `Decryption` ou `unwrap`. Ce constat ne couvre pas les bibliothèques natives, l’obfuscation, les autres noms de méthodes ni le firmware ; il ne prouve pas une absence de mécanisme de déchiffrement.

Conséquence : récupérer des ressources audio déjà en clair est une piste démontrée sur des échantillons. Récupérer les scénarios et rendre les onze histoires éditables reste non démontré. L’application officielle seule ne garantit pas l’accès aux clés effectives ; le protocole et le firmware restent des pistes de recherche.
