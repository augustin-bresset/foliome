import foliome from '@foliome/astro'
import { defineConfig } from 'astro/config'

export default defineConfig({
  integrations: [
    // What the artist can edit. Pages mark the matching zones with `edit('projects.<id>.title')`.
    foliome({
      name: 'Atelier Morane',
      // French first: it is the default. Fields marked `translate` hold one value per language.
      locales: ['fr', 'en'],
      // The command behind the "Mettre en ligne" button, e.g. FOLIOME_PUBLISH="npm run deploy".
      // Left unset, the button is not shown.
      publish: process.env.FOLIOME_PUBLISH,
      // Where a tunnel makes this server reachable from outside, e.g. FOLIOME_ADDRESS="https://atelier.example.org".
      // Once set, the access code is asked of everyone, on this machine too.
      address: process.env.FOLIOME_ADDRESS,
      // Keeps what the artist changes in git. Meant for a server: FOLIOME_GIT=1, and the commits go to the remote too.
      git: process.env.FOLIOME_GIT ? { push: true } : undefined,
      content: {
        site: {
          type: 'group',
          label: 'Atelier',
          fields: {
            name: { type: 'text', label: 'Nom de l’atelier' },
            baseline: { type: 'text', label: 'Phrase d’accueil', translate: true },
            about: { type: 'richtext', label: 'Présentation', translate: true },
            portrait: { type: 'file', label: 'Image de l’atelier', kinds: ['image'] },
            contact: {
              type: 'group',
              label: 'Contact',
              fields: {
                address: { type: 'longtext', label: 'Adresse' },
                email: { type: 'text', label: 'E-mail' },
                phone: { type: 'text', label: 'Téléphone' },
              },
            },
          },
        },
        projects: {
          type: 'list',
          label: 'Projets',
          itemLabel: 'Projet',
          addLabel: 'Nouveau projet',
          titleField: 'title',
          path: '/projets/{slug}',
          fields: {
            title: { type: 'text', label: 'Titre' },
            year: { type: 'text', label: 'Année' },
            place: { type: 'text', label: 'Lieu' },
            program: { type: 'select', label: 'Programme', options: ['Logement', 'Équipement public', 'Réhabilitation', 'Paysage'] },
            surface: { type: 'text', label: 'Surface', placeholder: '240 m²' },
            summary: { type: 'longtext', label: 'Résumé', translate: true, help: 'Une ou deux phrases, affichées en tête de page.' },
            cover: { type: 'file', label: 'Image de couverture', kinds: ['image'] },
            // A list inside each project.
            credits: {
              type: 'list',
              label: 'Crédits',
              itemLabel: 'Crédit',
              addLabel: 'Ajouter un crédit',
              titleField: 'role',
              fields: {
                role: { type: 'text', label: 'Rôle', translate: true },
                name: { type: 'text', label: 'Nom' },
              },
            },
            // The page body: the artist stacks blocks of different kinds, in any order.
            sections: {
              type: 'list',
              label: 'Sections de la page',
              types: {
                texte: { label: 'Texte', fields: { text: { type: 'richtext', label: 'Texte', translate: true } } },
                galerie: {
                  label: 'Galerie',
                  fields: { files: { type: 'files', label: 'Fichiers', help: 'Images, vidéos, sons, PDF, modèles 3D ou tout autre fichier.' } },
                },
                citation: {
                  label: 'Citation',
                  titleField: 'author',
                  fields: {
                    quote: { type: 'longtext', label: 'Citation', translate: true },
                    author: { type: 'text', label: 'Auteur' },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ],
})
