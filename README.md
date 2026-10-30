# Foliome

Des sites de portfolio codés sur mesure, que l'artiste met à jour lui-même : il clique sur une zone du site, un panneau s'ouvre à côté, il modifie, c'est enregistré.

Première étape : **édition locale**. Le serveur de développement du site sert aussi d'outil d'édition. L'artiste s'y connecte depuis son propre appareil, sur le même réseau. Le site en ligne reste entièrement statique.

## Démarrer

Node 22.18 ou plus récent est requis (`nvm use` prend la version du projet).

```sh
npm install
npm run dev        # le site de démo, sur cet ordinateur : http://localhost:4321/?edit
npm run edit       # idem, ouvert au réseau local pour une séance avec l'artiste
npm run build      # le site statique, dans apps/demo/dist
npm run seed       # remet le contenu de démo d'origine
npm test           # tests unitaires
npm run test:e2e   # une séance d'édition complète dans un vrai navigateur
```

## Une séance avec l'artiste

1. `npm run edit` affiche un lien du type `http://192.168.1.20:4321/?edit=ABCD-EFGH`.
2. L'artiste l'ouvre sur son appareil, connecté au même Wi-Fi. Le code est demandé à qui arrive sans ce lien.
3. Il modifie ; chaque enregistrement est écrit dans le dossier du site :
   - `content/content.json` pour les textes et la structure ;
   - `public/media/` pour les fichiers, quel que soit leur format.
4. Il met en ligne lui-même si une commande est configurée (voir plus bas). Sinon, après la séance : relire le `git diff`, committer, `npm run build`, déployer `dist/`.

Dans la barre de l'éditeur :

- **Modifier / Parcourir** : cliquer édite, ou laisse le site se comporter normalement.
- **Contenu** : tout ce qui est modifiable, y compris ce qu'on ne peut pas cliquer sur la page (contenu dessiné en WebGL, états masqués).
- **Annuler** : revient sur le dernier enregistrement (cent niveaux, gardés dans `.foliome/`, hors git).

Le code d'accès est conservé dans `.foliome/local.json` ; supprimer ce fichier en génère un nouveau et ferme les sessions ouvertes. Le lien ouvre aussi le serveur de développement à tout le réseau : à réserver à un réseau de confiance.

## Rendre un site éditable

Trois choses, toutes visibles dans `apps/demo`.

### 1. Déclarer le contenu

Dans `astro.config.mjs`, `content` décrit le fichier de contenu. Il n'y a qu'une brique, emboîtable à volonté : des champs, regroupés en `group` (un seul exemplaire) ou en `list` (autant d'éléments que l'artiste veut).

```js
foliome({
  name: 'Atelier Morane',
  content: {
    site: { type: 'group', label: 'Atelier', fields: { baseline: { type: 'text', label: 'Phrase d’accueil' } } },
    projects: {
      type: 'list', label: 'Projets', itemLabel: 'Projet', addLabel: 'Nouveau projet',
      titleField: 'title', path: '/projets/{slug}',
      fields: {
        title: { type: 'text', label: 'Titre' },
        cover: { type: 'file', label: 'Image de couverture', kinds: ['image'] },
        // Une liste dans chaque projet.
        credits: { type: 'list', label: 'Crédits', itemLabel: 'Crédit', titleField: 'role',
          fields: { role: { type: 'text', label: 'Rôle' }, name: { type: 'text', label: 'Nom' } } },
        // Une liste à plusieurs sortes d'éléments : l'artiste compose sa page bloc par bloc.
        sections: { type: 'list', label: 'Sections de la page', types: {
          texte: { label: 'Texte', fields: { text: { type: 'richtext', label: 'Texte' } } },
          galerie: { label: 'Galerie', fields: { files: { type: 'files', label: 'Fichiers' } } },
        } },
      },
    },
  },
})
```

| Type | Contenu |
|---|---|
| `text`, `longtext` | Texte sur une ligne, sur plusieurs |
| `richtext` | Texte avec gras, italique et liens |
| `select` | Un choix parmi `options` |
| `color` | Une couleur `#rrggbb` : le nuancier du système, le code, et des pastilles (`swatches`), par exemple la palette du site |
| `range` | Un nombre au curseur, de `min` à `max` (`step`, `unit` facultatifs) |
| `file`, `files` | Un fichier, plusieurs. `kinds: ['image']` restreint ce qui est accepté |
| `group` | Des champs, en un exemplaire |
| `list` | Des éléments ajoutables et réordonnables : `fields` pour une seule forme, `types` pour plusieurs |

Sur une liste : `addLabel` au premier niveau ajoute un bouton dans la barre ; `path` donne une page à chaque élément, avec un `slug` tiré du titre une fois pour toutes.

### 2. Lire le contenu

Depuis `@foliome/astro/content` :

| Fonction | Rôle |
|---|---|
| `getContent({ locale })` | Le contenu, dans la langue de la page |
| `url(asset)`, `srcset(asset)` | Adresse d'un fichier, et ses versions réduites pour une image |
| `richText(value)` | Le HTML d'un champ `richtext`, pour `set:html` |
| `isEditing()` | Vrai pendant l'édition |

### 3. Marquer les zones

`<h1 {...edit(`projects.${p.id}.title`)}>`. Le chemin suit le contenu ; dans une liste, on passe par l'`id` de l'élément : `projects.${p.id}.sections.${s.id}.text`. Selon ce qu'il désigne, le panneau montre un champ, un groupe, une liste entière ou un élément (qu'on peut alors déplacer et supprimer). Ces attributs n'existent que pendant l'édition ; le site construit n'en garde aucune trace.

Le rendu reste libre. Deux conventions aident l'éditeur à cohabiter avec les effets :

- après chaque enregistrement la page est rechargée avec la classe `foliome-quiet` sur `<html>` : le site peut s'en servir pour ne pas rejouer son animation d'entrée ;
- `html[data-foliome-mode="edit"]` est présent tant que le mode Modifier est actif.

Un site WebGL qui garde ses images dans la page, invisibles sous le canvas, reste éditable au clic : l'éditeur cherche les zones à travers ce qui les recouvre.

### 4. Montrer un réglage pendant qu'on le fait (facultatif)

Pour une couleur ou une lumière, recharger la page à chaque essai ne permet pas de régler finement. Tant qu'un panneau est ouvert, l'éditeur annonce chaque valeur en cours sur `window`, avant tout enregistrement :

```js
addEventListener('foliome:preview', (e) => {
  const { path, value } = e.detail // par exemple 'ambiance.blanc.sun', '#fff4e4'
  if (!path.startsWith('ambiance.')) return
  appliquer(path, value) // la scène change aussitôt
  e.preventDefault() // « je l'ai montré »
})
```

Le chemin est celui du champ dans le contenu (pour un groupe, sa valeur entière). Le site appelle `preventDefault()` sur ce qu'il a su appliquer :

- **Enregistrement** : quand tous les champs modifiés ont été montrés ainsi, la page n'est pas rechargée. L'éditeur relit seulement le contenu.
- **Abandon** : quand on ferme le panneau sans enregistrer, l'éditeur renvoie les valeurs d'origine des champs montrés.

Ce que le site ignore se comporte comme avant : rechargement après l'enregistrement.

## Plusieurs langues

`locales: ['fr', 'en']` dans la configuration (la première est celle par défaut), puis `translate: true` sur les champs de texte concernés. L'artiste voit alors un onglet par langue dans le panneau, ouvert sur la langue de la page (`<html lang>`). `getContent({ locale })` rend les valeurs dans la langue demandée, avec repli sur la langue par défaut. Les routes par langue restent l'affaire du site : la démo sert le français à la racine et l'anglais sous `/en`.

## Fichiers

À l'envoi, sur l'ordinateur qui héberge la séance :

- **Images** : redressées, débarrassées de leurs métadonnées (position GPS comprise), ramenées à 3200 px au plus, accompagnées de versions en 640, 1280 et 1920 px. HEIC et TIFF deviennent du JPEG.
- **Vidéos** : réencodées en MP4 (H.264, 1080p au plus) avec une image d'attente. `ffmpeg` doit être installé, sinon elles sont gardées telles quelles.
- **Le reste** (PDF, modèles 3D, sons, archives…) : gardé tel quel.

Seule la version préparée est conservée : l'original reste chez l'artiste. Chaque fichier porte un `kind` (`image`, `video`, `audio`, `pdf`, `model`, `file`) ; le site choisit le rendu, voir `apps/demo/src/components/Media.astro`.

## Mettre en ligne depuis l'éditeur

`publish: 'npm run deploy'` dans la configuration ajoute un bouton « Mettre en ligne » qui lance cette commande depuis le dossier du site. La démo la lit dans la variable `FOLIOME_PUBLISH`, pour ne pas inscrire une commande de déploiement dans le dépôt :

```sh
FOLIOME_PUBLISH="npm run build && rsync -a dist/ serveur:/var/www/site/" npm run edit
```

## Organisation

| Dossier | Rôle |
|---|---|
| `packages/core` | Types, chemins et opérations sur le contenu, formats de fichier, texte mis en forme, langues |
| `packages/server` | L'API d'édition, indépendante du stockage ; stockage sur disque ; préparation des fichiers |
| `packages/editor` | L'éditeur affiché par-dessus le site |
| `packages/astro` | L'intégration Astro : édition locale, code d'accès, lecture du contenu |
| `apps/demo` | Le site de référence |
| `tests/e2e.mjs` | La séance d'édition rejouée dans un navigateur |

## Pas encore fait

- Les fichiers retirés du contenu restent dans `public/media/`.
- Une liste avec `path` (une page par élément) n'est prise en charge qu'au premier niveau du contenu.
- Le texte mis en forme n'a été vérifié que dans Chrome.
- La version hébergée (édition à distance, sans passer par l'ordinateur du développeur) : `packages/server` est prévu pour recevoir un second stockage.
