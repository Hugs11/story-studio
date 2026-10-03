export const RELEASE_NOTES = Object.freeze({
  version: '0.9.9',
  date: '2026-10-03',
  message: [
    'Bienvenue dans la 0.9.9 ! Cette mise à jour introduit l’Éditeur graphe, et Story Studio se rapproche de ce que je voulais en faire.',
    'J’ai besoin de toi ! Signale-moi les bugs et partage tes retours. J’ai créé un serveur Discord pour que ce soit plus simple de discuter et de suivre les problèmes ensemble.',
    'Avec trois éditeurs, des outils audio et image, et maintenant Windows, Linux et macOS, je ne peux pas tout tester sur toutes les plateformes sans ton aide. Merci de contribuer à faire avancer Story Studio !',
  ],
  highlights: [
    ['Éditeur graphe', 'Écrans, Listes de choix et raccords visibles.'],
    ['Contrôles avant génération du ZIP', 'Navigation, médias et archive générée vérifiés.'],
  ],
  fixes: [
    ['UUID des packs', 'L’identifiant choisi est conservé à la génération du ZIP.'],
    ['Imports YouTube', 'Imports plus robustes et choix de langue corrigé.'],
    ['Navigation importée', 'Corrections des choix imbriqués, retours et fins de parcours.'],
    ['Éditeur simplifié', 'Génération des packs et harmonisation audio corrigées.'],
    ['Sauvegarde et récupération', 'Corrections des sessions récupérées et des médias associés.'],
  ],
  chores: [],
  discordUrl: 'https://discord.gg/jztpQz5Ad',
  changelogUrl: 'https://github.com/Hugs11/story-studio/blob/main/CHANGELOG.md',
});

export function shouldShowReleaseNotes(appVersion, seenVersion) {
  return appVersion === RELEASE_NOTES.version && seenVersion !== appVersion;
}
