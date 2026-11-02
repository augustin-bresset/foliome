import foliome from '@foliome/astro'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://foliome.eu',
  // Through a tunnel live reload would knock on the wrong port; the editor reloads pages itself.
  vite: process.env.FOLIOME_REMOTE ? { server: { hmr: false } } : {},
  integrations: [
    // foliome.eu is edited with Foliome, like the sites it presents.
    foliome({
      name: 'Foliome',
      locales: ['fr', 'en'],
      // The command behind the "Mettre en ligne" button, e.g. FOLIOME_PUBLISH="npm run build && rsync -a --delete dist/ /var/www/foliome/".
      publish: process.env.FOLIOME_PUBLISH,
      // Where a tunnel makes this server reachable from outside. Once set, the access code is asked of everyone.
      address: process.env.FOLIOME_ADDRESS,
      // Keeps what is changed in git. Meant for the server: FOLIOME_GIT=1, and the commits go to GitHub too.
      git: process.env.FOLIOME_GIT ? { push: true } : undefined,
      content: {
        sites: {
          type: 'list',
          label: 'Sites réalisés',
          itemLabel: 'Site',
          addLabel: 'Nouveau site',
          titleField: 'name',
          fields: {
            name: { type: 'text', label: 'Nom' },
            role: { type: 'text', label: 'Activité, ville', translate: true },
            url: {
              type: 'text',
              label: 'Adresse du site',
              placeholder: 'https://…',
              help: 'Laissez vide tant que le site n’est pas ouvert : « Bientôt en ligne » s’affiche à la place.',
            },
          },
        },
        contact: {
          type: 'group',
          label: 'Contact',
          fields: {
            email: { type: 'text', label: 'E-mail' },
          },
        },
      },
    }),
  ],
})
