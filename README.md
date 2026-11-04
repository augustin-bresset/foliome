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
node scripts/reset-demo.mjs  # remet la démo telle qu'elle est dans le dépôt, en un instant
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

## Plusieurs sites sur un serveur : la porte

Un serveur d'édition prend 400 à 550 Mo. Sur un serveur partagé, aucun ne tourne en permanence : `packages/door`, seul toujours en marche, les réveille et les endort.

- **Entrer** : l'artiste donne son code sur la page d'accueil. La porte le compare aux codes des sites, lus dans leur `.foliome/local.json`, et ne réveille que le site concerné. Un mauvais code ne réveille rien ; les essais sont comptés par visiteur et pour tous.
- **Combien** : au plus trois serveurs à la fois, la démo à part. Pour en réveiller un quatrième, la porte endort d'abord un site sans éditeur ouvert, le plus longtemps inactif d'abord ; à défaut, un site dont l'éditeur est ouvert mais sans activité depuis au moins 10 minutes, là encore le plus inactif d'abord. Si aucun ne peut partir, elle répond que le serveur est occupé.
- **Céder la place** : l'artiste dont l'éditeur est fermé ainsi le voit dire pourquoi (« L'édition s'est fermée après 10 minutes sans activité, pour laisser la place à un autre artiste »). La porte l'en avertit à l'avance, dès que son site peut céder la place : un onglet que le navigateur a mis en veille n'entendrait pas un message envoyé au dernier moment. Avec des modifications non enregistrées, le site ne cède la place qu'une fois leurs brouillons arrivés sur le serveur, et le message dit qu'elles sont gardées. Un envoi de fichier ou une mise en ligne en cours n'est jamais coupé.
- **Fermer** : sans activité pendant 25 minutes, l'éditeur prévient l'artiste ; à 30 minutes le site s'endort, et son arrêt enregistre son travail dans git. Avec des modifications pas encore enregistrées, il attend jusqu'à une heure. Sans aucun éditeur ouvert, il s'endort après 10 minutes.
- **Parler aux sites** : la porte et les sites partagent la clé `FOLIOME_DOOR_KEY`. Sans elle, `/_foliome/door` n'existe pas.

### La démo, à tour de rôle

Un site marqué `"demo": true` (l'Atelier Morane, `apps/demo`) est prêté à qui veut l'essayer, sans code, depuis le bouton « Essayer la démo » de foliome.eu.

- **Un à la fois** : un visiteur a la démo pour lui seul pendant 10 minutes. Les suivants attendent dans une file : la page d'accueil leur dit leur place et l'attente estimée (« Vous êtes 2e dans la file : environ 18 minutes d'attente »), et les envoie sur la démo quand leur tour vient, sans qu'ils aient à recharger.
- **La file** : la page garde un ticket et redemande sa place toutes les trois secondes ; une page qui cesse de demander pendant 30 secondes perd sa place. Fermer le panneau la rend aussitôt ; recharger la page la garde. La file compte au plus 40 personnes, et deux places par adresse, dix demandes par adresse en cinq minutes.
- **Son tour** : la porte démarre la démo, ou la redémarre si elle a déjà servi (son service remet d'abord le contenu d'origine, voir plus bas), puis lui demande une session valable pour tout le tour, ce qui ferme toute autre session. Le site lui rend un ticket à usage unique, et le visiteur est envoyé sur `https://<nom de la démo>/?ticket=…`. Le serveur d'édition échange le ticket contre son cookie de session et retire le ticket de l'adresse. Un ticket déjà utilisé ou expiré mène à la page d'entrée, qui renvoie vers foliome.eu pour demander son tour.
- **La fin** : deux minutes avant la fin, l'éditeur affiche le temps qui reste. À la fin, la session se ferme, le serveur s'arrête et le suivant passe.
- **Plus tôt** : un visiteur qui n'ouvre pas la démo dans les 90 secondes, ou qui la quitte (aucun éditeur ouvert depuis une minute environ), laisse la place au suivant.
- **Sa place à elle** : la démo ne compte pas parmi les trois serveurs des artistes, ne leur prend jamais leur place, et la logique qui endort leurs sites ne la touche pas. Son code ne mène nulle part.

### Configuration

La porte lit sa configuration dans le fichier nommé par `FOLIOME_DOOR_CONFIG` :

```json
{
  "home": "https://foliome.eu",
  "sites": [
    { "name": "tom.foliome.eu", "port": 4331, "root": "/srv/foliome/tom-conan", "unit": "foliome-site@tom-conan.service" },
    { "name": "demo.foliome.eu", "port": 4340, "root": "/srv/foliome/foliome/apps/demo", "unit": "foliome-site@demo.service", "demo": true }
  ],
  "limits": { "awake": 3, "afk": 600000, "demo": 600000 }
}
```

Tout ce qui est dans `limits` est facultatif ; les durées sont en millisecondes.

| Limite | Par défaut | Rôle |
|---|---|---|
| `awake` | 3 | Serveurs d'artistes réveillés à la fois, la démo à part |
| `warn`, `close`, `closeUnsaved`, `alone` | 25, 30, 60, 10 min | Prévenir, fermer, fermer malgré des modifications non enregistrées, fermer sans éditeur ouvert |
| `afk` | 10 min | Sans activité depuis ce temps, un éditeur ouvert cède la place à un artiste qui arrive |
| `waking` | 90 s | Temps laissé à un serveur pour se réveiller |
| `demo` | 10 min | Le tour d'un visiteur sur la démo |
| `demoWarn` | 2 min | Le temps restant s'affiche à partir de là |
| `arrive` | 90 s | Sans éditeur ouvert après ce délai, le tour passe au suivant |
| `linger` | 30 s | Une page de la file qui ne demande plus sa place depuis ce temps la perd |
| `line`, `places` | 40, 2 | Personnes dans la file ; places par adresse |

Elle démarre et arrête les services par `systemctl`, sans mot de passe : une règle polkit doit le lui permettre pour ces services-là seulement. Le serveur web devant elle lui transmet `POST /entrer` et `POST /entrer/demo` depuis foliome.eu, et écrit lui-même l'en-tête `X-Forwarded-For`.

### Le service de la démo

La démo tourne comme les autres sites, dans le dossier `apps/demo` d'un clone du dépôt, avec trois choses en plus : `FOLIOME_DEMO=1`, qui la restreint (voir plus bas), son adresse publique, et la remise à neuf avant chaque démarrage. Par exemple, en complément du service des sites :

```ini
# /etc/systemd/system/foliome-site@demo.service.d/demo.conf
[Service]
WorkingDirectory=/srv/foliome/foliome/apps/demo
Environment=FOLIOME_DEMO=1
Environment=FOLIOME_ADDRESS=https://demo.foliome.eu
EnvironmentFile=/etc/foliome/door.env
ExecStartPre=/usr/bin/node /srv/foliome/foliome/scripts/reset-demo.mjs /srv/foliome/foliome/apps/demo
```

`/etc/foliome/door.env` contient `FOLIOME_DOOR_KEY=…`, la même clé que la porte. Le port est celui de la configuration de la porte (4340 ici).

`scripts/reset-demo.mjs` remet `content/` et `public/media/` tels qu'ils sont dans le dépôt (`git checkout` et `git clean`, sans réseau, en une fraction de seconde) et efface ce que les visiteurs ont laissé : historique d'annulation, brouillons, sessions. `npm run seed`, lui, régénère tout le contenu de démo : une vingtaine de secondes et un processeur entier, à éviter avant chaque visiteur.

### Un site prêté : `restricted`

L'option `restricted: true` prépare un site à être prêté à des inconnus ; la démo la lit dans `FOLIOME_DEMO`.

- Le code d'accès n'ouvre rien : on n'entre que par un ticket donné par la porte, pour une session de la durée qu'elle a fixée.
- Ni mise en ligne ni git, quelle que soit la configuration.
- 15 Mo par fichier (sauf `maxFileSize`) et 100 Mo en tout par session (`restricted: { mediaBudget: … }` en octets).
- Les pages portent `X-Robots-Tag: noindex`.
- Chaque session donnée par la porte efface les brouillons de la précédente.

### Ce que la porte attend des sites

La porte est la partie serveur, et pourrait vivre dans un dépôt à part. Des sites, elle n'utilise que `/_foliome/door`, toujours avec l'en-tête `X-Foliome-Door: <clé>`, sous leur nom public :

| Requête | Réponse |
|---|---|
| `GET` | La présence : `idle` (ms depuis la dernière activité), `dirty` (des modifications non enregistrées), `editors` (éditeurs ouverts), `busy` (envoi ou mise en ligne en cours), `drafted` (tout ce qui n'est pas enregistré est arrivé en brouillon) |
| `POST { "notice": … }` | Un message pour l'éditeur : `closing` (`at`, `unsaved`, `reason`), `closed` (`home`, `reason`, `after`), `standby` (rien à afficher : dit pourquoi si la session se ferme sans autre avertissement), ou `null`. `reason` vaut `idle`, `room` ou `time` |
| `POST { "grant": { "ms": …, "home": … } }` | Ferme toutes les sessions et en prépare une de `ms` millisecondes ; rend `{ "ticket": … }`, à échanger une fois, dans les deux minutes, sur `/?ticket=…`. `home` est l'adresse où renvoyer qui arrive sans ticket valable |

## Organisation

| Dossier | Rôle |
|---|---|
| `packages/core` | Types, chemins et opérations sur le contenu, formats de fichier, texte mis en forme, langues |
| `packages/server` | L'API d'édition, indépendante du stockage ; stockage sur disque ; préparation des fichiers |
| `packages/editor` | L'éditeur affiché par-dessus le site |
| `packages/astro` | L'intégration Astro : édition locale, code d'accès, lecture du contenu, enregistrement dans git |
| `packages/door` | La porte d'un serveur partagé : le code mène au bon site, qu'elle réveille et endort ; la file de la démo |
| `apps/demo` | Le site de référence |
| `apps/home` | foliome.eu, modifié avec Foliome comme les sites qu'il présente (`npm run home`) |
| `scripts/seed-demo.mjs`, `scripts/reset-demo.mjs` | Générer le contenu de la démo ; la remettre à neuf |
| `tests/e2e.mjs` | La séance d'édition rejouée dans un navigateur |

## Pas encore fait

- Les fichiers retirés du contenu restent dans `public/media/`.
- Une liste avec `path` (une page par élément) n'est prise en charge qu'au premier niveau du contenu.
- Le texte mis en forme n'a été vérifié que dans Chrome.
- La file de la démo n'est gardée qu'en mémoire : redémarrer la porte la vide, et ferme la démo en cours.
- Un élément en cours de création n'a pas de brouillon de secours.
- La version hébergée (édition à distance sans que l'ordinateur du développeur soit allumé) : `packages/server` est prévu pour recevoir un second stockage.
