<img src=".github/logo.svg" width="96" height="96" alt="">

# Foliome

Site : [foliome.eu](https://foliome.eu)

Des sites de portfolio codés sur mesure, que l'artiste met à jour lui-même : il clique sur une zone du site, un panneau s'ouvre à côté, il modifie, c'est enregistré.

Première étape : **édition locale**. Le serveur de développement du site sert aussi d'outil d'édition. L'artiste s'y connecte depuis son propre appareil, sur le même réseau ou de chez lui par un tunnel. Le site en ligne reste entièrement statique.

## Démarrer

Node 22.18 ou plus récent est requis (`nvm use` prend la version du projet).

```sh
npm install
npm run dev        # le site de démo, sur cet ordinateur : http://localhost:4321/?edit
npm run edit       # idem, ouvert au réseau local pour une séance avec l'artiste
npm run build      # le site statique, dans apps/demo/dist
npm run seed       # régénère le contenu de démo d'origine (images, film, modèle 3D)
npm test           # tests unitaires
npm run test:e2e   # une séance d'édition complète dans un vrai navigateur
```

## Une séance avec l'artiste

1. `npm run edit` affiche un lien du type `http://192.168.1.20:4321/?edit=ABCD-EFGH`.
2. L'artiste l'ouvre sur son appareil, connecté au même Wi-Fi. Son navigateur est ensuite reconnu pendant trente jours. Le code est demandé à qui arrive sans ce lien.
3. Il modifie ; chaque enregistrement est écrit dans le dossier du site :
   - `content/content.json` pour les textes et la structure ;
   - `public/media/` pour les fichiers, quel que soit leur format.
4. Il met en ligne lui-même si une commande est configurée (voir plus bas). Sinon, après la séance : relire le `git diff`, committer, `npm run build`, déployer `dist/`.

Dans la barre de l'éditeur :

- **Modifier / Parcourir** : cliquer édite, ou laisse le site se comporter normalement.
- **Contenu** : tout ce qui est modifiable, y compris ce qu'on ne peut pas cliquer sur la page (contenu dessiné en WebGL, états masqués).
- **Annuler** : revient sur le dernier enregistrement (cent niveaux, gardés dans `.foliome/`, hors git).

### Modifications non enregistrées

Tant qu'un panneau contient des modifications pas encore enregistrées, l'éditeur les envoie au serveur avec ses signes de vie (toutes les trente secondes, et dès que l'onglet revient au premier plan) : le chemin de chaque champ modifié et sa valeur en cours, jamais les fichiers en cours d'envoi. Le serveur garde la dernière version de chaque champ dans `.foliome/drafts.json`.

- Enregistrer le champ, ou fermer le panneau sans enregistrer, efface son brouillon.
- Si l'onglet se ferme, ou si le serveur s'arrête, le brouillon reste. Quand l'artiste rouvre ce champ, et si le brouillon diffère de ce qui est enregistré, le panneau propose « Reprendre les modifications non enregistrées du 4 novembre à 18 h 12 ? » : **Reprendre** remet les valeurs dans le panneau, **Ignorer** efface le brouillon.
- Seuls les éléments qui existent déjà ont des brouillons : un élément en cours de création n'en a pas.

Le code d'accès est conservé dans `.foliome/local.json` ; supprimer ce fichier puis relancer le serveur en génère un nouveau et ferme les sessions ouvertes. Sans ce code, le serveur ne donne qu'une page qui le demande : ni le site, ni son code source. Seul le navigateur du développeur, sur l'ordinateur qui fait tourner le serveur, en est dispensé.

## À distance, par un tunnel

L'artiste n'a pas à être sur le même réseau. Un tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel…) donne une adresse publique au serveur de développement, tant que l'ordinateur est allumé et le serveur lancé. Il pointe vers `http://localhost:4321`, et son adresse doit être déclarée :

```sh
FOLIOME_ADDRESS="https://atelier.exemple.fr" npm run dev
```

Le terminal affiche alors le lien à envoyer à l'artiste, du type `https://atelier.exemple.fr/?edit=ABCD-EFGH`.

Une fois l'adresse déclarée, le code est demandé à tout le monde, y compris sur l'ordinateur du développeur : ce qui arrive par un tunnel vient de cette machine aussi, et rien ne le distingue du navigateur du développeur. **Ne jamais ouvrir un tunnel vers le serveur sans la déclarer.**

Dans la configuration du site, c'est l'option `address` ; la démo la lit dans `FOLIOME_ADDRESS`.

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

L'éditeur, lui, parle la langue du navigateur de l'artiste, français ou anglais, quelle que soit la langue de la page. Les libellés écrits dans la configuration du site (`label`, `help`, `addLabel`) s'affichent tels quels.

## Fichiers

À l'envoi, sur l'ordinateur qui héberge la séance :

- **Images** : redressées, débarrassées de leurs métadonnées (position GPS comprise), ramenées à 3200 px au plus, accompagnées de versions en 640, 1280 et 1920 px. HEIC et TIFF deviennent du JPEG.
- **Vidéos** : réencodées en MP4 (H.264, 1080p au plus) avec une image d'attente. `ffmpeg` doit être installé, sinon elles sont gardées telles quelles.
- **Le reste** (PDF, modèles 3D, sons, archives…) : gardé tel quel.

Un fichier peut peser jusqu'à 2 Go. `maxFileSize` (en octets) abaisse cette limite pour un site, par exemple `maxFileSize: 200 * 1024 ** 2` ; l'éditeur refuse alors un fichier trop lourd avant même de l'envoyer, et dit quelle est la limite.

Seule la version préparée est conservée : l'original reste chez l'artiste. Chaque fichier porte un `kind` (`image`, `video`, `audio`, `pdf`, `model`, `file`) ; le site choisit le rendu, voir `apps/demo/src/components/Media.astro`.

## Mettre en ligne depuis l'éditeur

`publish: 'npm run deploy'` dans la configuration ajoute un bouton « Mettre en ligne » qui lance cette commande depuis le dossier du site. La démo la lit dans la variable `FOLIOME_PUBLISH`, pour ne pas inscrire une commande de déploiement dans le dépôt :

```sh
FOLIOME_PUBLISH="npm run build && rsync -a dist/ serveur:/var/www/site/" npm run edit
```

## Garder le contenu dans git

Sur un serveur que l'artiste utilise seul, l'option `git` enregistre son travail dans le dépôt du site. La démo la lit dans la variable `FOLIOME_GIT` :

```js
git: process.env.FOLIOME_GIT ? { push: true } : undefined,
```

- **Quand** : dix minutes après le dernier enregistrement, avant chaque mise en ligne, et à l'arrêt du serveur.
- **Quoi** : `content/` et `public/media/`, rien d'autre. Le code en cours dans le dossier n'est jamais embarqué, ni un fichier encore en cours d'envoi.
- **Qui** : les commits sont signés `Foliome (nom du site)`, sans configuration git sur la machine.
- **Avec `push`** : ce qui est nouveau sur le dépôt distant est d'abord fusionné, puis les commits sont envoyés. Il faut une branche suivie (`git push -u`) et un accès sans mot de passe, par exemple une clé de déploiement.

Rien de tout cela ne gêne l'artiste : en cas d'échec, l'enregistrement et la mise en ligne continuent, l'erreur apparaît dans le terminal du serveur et l'envoi est retenté à la fois suivante.

Une fois le site sur un serveur, `content/` lui appartient : le modifier à la main ailleurs mène à un conflit, qui bloque l'envoi jusqu'à ce qu'il soit résolu. Le travail de l'artiste, lui, reste enregistré sur le serveur.

## Faire tourner Foliome pour d'autres : l'API d'hébergement

Un serveur d'édition peut être lancé, endormi et surveillé par un programme à côté de lui, l'hébergeur : celui qui sait combien de sites tiennent sur la machine, qui y entre et pour combien de temps. Foliome n'en connaît aucun en particulier. Il offre à n'importe lequel l'API ci-dessous, à laquelle se tenir ; l'hébergement de foliome.eu en est un, dans un dépôt à part.

Pour l'activer, le serveur d'édition et l'hébergeur partagent une clé, `FOLIOME_HOST_KEY` (option `hostKey` de `createLocal`). Sans elle, `/_foliome/host` n'existe pas. Chaque requête porte l'en-tête `X-Foliome-Host: <clé>` et arrive sous le nom public du site, avec `Origin: https://<nom public>` pour un `POST`, comme le feraient ses propres pages. Sans la bonne clé, la réponse est un 404.

### Ce qui se passe : `GET /_foliome/host`

```json
{
  "idle": 42000, "dirty": true, "editors": 1, "busy": false, "drafted": true,
  "uploads": 0, "publishing": false, "restoring": false,
  "sessions": [{ "id": "9f2c41d07ab3e815", "seen": 12000, "idle": 42000, "dirty": true, "drafted": true }]
}
```

| Champ | Sens |
|---|---|
| `idle` | Millisecondes depuis la dernière action de l'artiste, toutes sessions confondues |
| `dirty` | Un panneau ouvert tient des modifications non enregistrées |
| `editors` | Éditeurs ouverts, d'après leurs signes de vie (un toutes les trente secondes) |
| `busy` | Une requête est en cours, envoi de fichier ou mise en ligne : arrêter maintenant la couperait |
| `drafted` | Tout ce qui n'est pas enregistré est arrivé en brouillon de secours : fermer ne perd rien |
| `uploads`, `publishing` | Fichiers en cours d'envoi ; mise en ligne en cours |
| `restoring` | The content is being brought back to an earlier version (see below) |
| `sessions` | Un élément par éditeur ouvert : `id` (pour lui parler, `local` pour le navigateur du développeur), `seen` (ms depuis son dernier signe de vie), `idle`, `dirty`, `drafted` |

### Ouvrir une session : `POST /_foliome/host/grant`

`{ "ms": 600000, "home": "https://exemple.org/#demo" }` ferme toutes les sessions et en prépare une de `ms` millisecondes. La réponse, `{ "ticket": "…" }`, s'échange une fois, dans les deux minutes, en envoyant le visiteur sur `https://<nom public>/?ticket=…` : le serveur pose son cookie de session et retire le ticket de l'adresse. Un ticket déjà utilisé ou expiré mène à la page d'entrée. `home` est l'adresse où renvoyer qui arrive sans session sur un site `restricted`.

### Parler aux artistes : `POST /_foliome/host/notice`

```json
{
  "notice": {
    "text": { "fr": "Maintenance dans {countdown}. Pensez à enregistrer.", "en": "Maintenance in {countdown}. Remember to save." },
    "level": "warning",
    "in": 600000,
    "actions": [{ "label": { "fr": "Compris", "en": "Got it" } }, { "label": "État du service", "href": "https://exemple.org/etat" }]
  },
  "farewell": { "text": "L'édition est fermée.", "final": true, "actions": [{ "label": "Rouvrir", "do": "reload" }] },
  "to": "9f2c41d07ab3e815"
}
```

Un message, l'éditeur l'affiche tel quel : Foliome ne lui donne aucun sens. Fermer une session, prévenir d'une maintenance ou annoncer une nouveauté ne sont que des usages.

| Champ du message | Sens |
|---|---|
| `text` | Un texte, ou un par langue (`fr`, `en`…) : l'éditeur montre celui de la langue de l'artiste, sinon le premier. Au plus 2000 caractères |
| `level` | `info` (par défaut), `warning` ou `error` |
| `in` | Un compte à rebours, en millisecondes à partir de maintenant : `{countdown}` dans le texte affiche le temps qui reste (« 4 minutes », « moins d'une minute »), tenu à jour, compté sur l'horloge du serveur |
| `actions` | Jusqu'à quatre boutons, chacun avec son `label`. Par défaut un bouton range le message et signale que l'artiste est là ; `"do": "reload"` recharge la page ; `"href"` mène à une adresse `http(s)` |
| `final` | La session est finie : l'éditeur cesse de parler au serveur et n'affiche plus que ce message |
| `untilActive` | Le message disparaît dès que l'artiste fait quoi que ce soit : une remarque sur son absence, par exemple |

- `notice` est affiché tout de suite, au prochain signe de vie de l'éditeur ; `null` le retire.
- `farewell` n'est affiché que si le serveur cesse de répondre et que la session n'est plus valable : c'est ce que l'éditeur dira si l'hébergeur arrête le serveur sans prévenir une dernière fois, par exemple parce qu'un onglet en veille n'aurait rien entendu. `null` le retire.
- Un champ absent ne change rien à ce qui avait été dit.
- Sans `to`, le message va à tous les éditeurs, et remplace ce que chacun avait reçu seul. Avec `to`, il ne va qu'à cette session (404 `no_session` si elle n'existe pas).

### Fermer une session : `POST /_foliome/host/close`

`{ "to": "9f2c41d07ab3e815", "notice": { … } }` termine la session tout de suite, ou toutes sans `to` : son cookie n'ouvre plus rien. Ce que son éditeur tenait sans l'avoir enregistré n'est pas perdu : ce qu'il avait déjà envoyé reste en brouillon de secours, et à son prochain signe de vie il remet ce qu'il tient encore, puis affiche `notice`, rendu `final`. L'artiste retrouvera ces brouillons à son retour. La réponse dit combien de sessions sont fermées et si tout ce qui n'était pas enregistré était déjà arrivé : `{ "ok": true, "closed": 1, "drafted": true }`.

### Restoring an earlier version: `POST /_foliome/host/restore`

`{ "commit": "3f9c2ab", "notice": { … } }` brings the site's content back to what it was at that commit, and puts the site online as it was then. Only with the `git` option: without it the answer is a 404 `not_configured`.

- **Only the content goes back**: `content/` and `public/media/`, files added since removed and files removed since put back. The code, and every technical update made since, stay as they are.
- **Nothing is rewritten**: whatever the artist saved and was not committed yet is committed first; a branch `before-restore/<YYYY-MM-DD-HHMM>` (server time) is made where HEAD was; the old version becomes a new commit on top, signed `Foliome (<site>)`, with the message `content: back to the version of <ISO date> (<short hash>)`, the date being the author date of that commit. A restore is undone by restoring the commit just before it. With `push`, the branch is sent along with the commit.
- **Only a commit of the site's history**: a hash of 7 to 40 hexadecimal characters, which HEAD descends from. Anything else is a 400, `bad_commit` or `unknown_commit`.
- **Refused, with a reason, while something is going on**: `409` with `editing` (an open editor holds unsaved changes), `uploading`, `publishing` or `restoring`. `unchanged` (409): the content is already as it was then. While a restore runs, saving, undoing, uploading and publishing are refused (`409 restoring`).
- **When the old content no longer fits the site**, nothing changes: the files are put back, the branch removed, nothing is committed and the public site is untouched. `422` with `misfit` (the content does not have the shape the schema gives it: `detail` lists where) or `build` (the publish command failed: `detail` is the end of its output). The site's publish command is the check: without one, only the schema is.
- **Success**: `{ "ok": true, "commit": "<new commit>", "from": "<commit restored>", "date": "<its ISO date>", "branch": "before-restore/2026-11-05-1630" }`. The undo history of the editor is emptied, since it would lead back to files that are gone.
- **Open editors**: each editor that read the content before the restore is shown `notice` (a notice as for `/notice`; Foliome's own words, with a reload button, without it) until its page is loaded again, whatever else the host says meanwhile.
- A failure of git itself is a `500` `failed`, after everything has been put back.

The request lasts as long as the build: give it several minutes.

### Un site prêté : `restricted`

L'option `restricted: true` prépare un site à être prêté à des inconnus, par exemple une démo publique ; la démo la lit dans `FOLIOME_DEMO`.

- Le code d'accès n'ouvre rien : on n'entre que par un ticket de l'hébergeur, pour une session de la durée qu'il a fixée.
- Ni mise en ligne ni git, quelle que soit la configuration.
- 15 Mo par fichier (sauf `maxFileSize`) et 100 Mo en tout par session (`restricted: { mediaBudget: … }` en octets).
- Les pages portent `X-Robots-Tag: noindex`.
- Chaque session donnée par l'hébergeur efface les brouillons de la précédente.

## Organisation

| Dossier | Rôle |
|---|---|
| `packages/core` | Types, chemins et opérations sur le contenu, formats de fichier, texte mis en forme, langues |
| `packages/server` | L'API d'édition, indépendante du stockage ; stockage sur disque ; préparation des fichiers |
| `packages/editor` | L'éditeur affiché par-dessus le site |
| `packages/astro` | L'intégration Astro : édition locale, code d'accès, lecture du contenu, enregistrement dans git |
| `apps/demo` | Le site de référence |
| `apps/home` | foliome.eu, modifié avec Foliome comme les sites qu'il présente (`npm run home`) |
| `scripts/seed-demo.mjs` | Générer le contenu de la démo |
| `tests/e2e.mjs` | La séance d'édition rejouée dans un navigateur |

## Pas encore fait

- Les fichiers retirés du contenu restent dans `public/media/`.
- Une liste avec `path` (une page par élément) n'est prise en charge qu'au premier niveau du contenu.
- Le texte mis en forme n'a été vérifié que dans Chrome.
- Un élément en cours de création n'a pas de brouillon de secours.
- La version hébergée (édition à distance sans que l'ordinateur du développeur soit allumé) : `packages/server` est prévu pour recevoir un second stockage.
