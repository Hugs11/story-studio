import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const base = '/story-studio';

export default defineConfig({
  site: 'https://hugs11.github.io',
  base,
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Documentation Story Studio',
      description:
        "Comprendre la structure, la navigation et les workflows de création d'un pack Story Studio.",
      locales: {
        root: {
          label: 'Français',
          lang: 'fr',
        },
      },
      logo: {
        src: './public/logostory.svg',
        alt: 'Story Studio',
      },
      favicon: '/logostory.svg',
      social: [
        {
          icon: 'github',
          label: 'Dépôt GitHub de Story Studio',
          href: 'https://github.com/Hugs11/story-studio',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/Hugs11/story-studio/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'Où commencer',
          items: [
            { slug: 'docs/concept' },
            { slug: 'docs/menu-racine' },
            { slug: 'docs/dossier' },
            { slug: 'docs/histoire' },
            { slug: 'docs/message-de-fin' },
            { slug: 'docs/exemples-de-structures' },
            { slug: 'docs/navigation' },
          ],
        },
        {
          label: 'Créer ou reprendre',
          items: [
            { slug: 'docs/editeur-libre' },
            { slug: 'docs/editeur-simplifie' },
            { slug: 'docs/modifier-un-pack-existant' },
            { slug: 'docs/creer-un-pack-depuis-un-podcast' },
            { slug: 'docs/creer-un-pack-depuis-youtube' },
            { slug: 'docs/agreger-des-packs' },
            { slug: 'docs/verifier-un-pack' },
            { slug: 'docs/ouvrir-un-projet' },
          ],
        },
        {
          label: 'Éditer et préparer les médias',
          items: [
            { slug: 'docs/espace-d-edition' },
            { slug: 'docs/gestionnaire-de-medias' },
            { slug: 'docs/preparer-les-images' },
            { slug: 'docs/enregistrer-un-audio' },
            { slug: 'docs/editeur-audio' },
            { slug: 'docs/decouper-un-audio' },
            { slug: 'docs/assembler-des-audios' },
          ],
        },
        {
          label: 'Projets, import et export',
          items: [
            { slug: 'docs/workspace-et-fichiers-de-projet' },
            { slug: 'docs/sessions-temporaires-et-recuperation' },
            { slug: 'docs/importer-et-extraire-un-pack' },
            { slug: 'docs/preparer-et-exporter' },
            { slug: 'docs/projet-mbah-ou-extraction-zip' },
          ],
        },
        {
          label: 'Intégrations',
          items: [
            { slug: 'docs/voix-locales-piper-xtts' },
            { slug: 'docs/comfyui' },
          ],
        },
        {
          label: 'Aide',
          items: [
            { slug: 'docs/preferences-et-raccourcis' },
            { slug: 'docs/resoudre-un-blocage-generation' },
          ],
        },
        {
          label: 'Story Studio',
          items: [
            { label: 'Accueil du site', link: '/' },
            {
              label: 'Signaler un bug',
              link: 'https://github.com/Hugs11/story-studio/issues',
            },
          ],
        },
      ],
      customCss: ['./src/styles/starlight.css'],
      pagefind: true,
      pagination: false,
      disable404Route: true,
    }),
  ],
});
