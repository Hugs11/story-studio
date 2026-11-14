# Documentation du domaine

## Avant d’explorer le code

Lire `GLOSSARY.md` à la racine, puis les décisions de `docs/adr/`
qui concernent la zone étudiée.

Si un document est absent, poursuivre silencieusement.
La compétence domain-modeling crée ces documents lorsque des termes
ou des décisions sont effectivement établis.

## Organisation

Le dépôt utilise un contexte unique (single-context) :

- `GLOSSARY.md` : vocabulaire du domaine.
- `docs/adr/` : décisions d’architecture.

Les ADR seront créées au fil des décisions.

## Employer le vocabulaire du glossaire

Utiliser les termes définis dans le glossaire pour nommer les concepts
du domaine dans les tickets, propositions, hypothèses et tests.
Respecter les synonymes explicitement déconseillés.

Si un concept manque, vérifier sa pertinence et signaler le besoin
à domain-modeling.

## Signaler les conflits avec les ADR

Toute proposition contredisant une ADR doit identifier cette décision
et expliquer pourquoi sa révision est proposée.
