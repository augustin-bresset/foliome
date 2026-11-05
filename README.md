<img src=".github/logo.svg" width="96" height="96" alt="">

# Foliome

Website: [foliome.eu](https://foliome.eu)

Hand-coded portfolio sites that artists keep up to date themselves: they click an area of the site, a panel opens beside it, they make their change, and it is saved.

First step: **local editing**. The site's development server is also the editing tool. Artists connect to it from their own device, on the same network, or from home through a tunnel. The live site stays fully static.

## Getting started

Node 22.18 or later is required (`nvm use` picks the project's version).

```sh
npm install
npm run dev        # the demo site, on this computer: http://localhost:4321/?edit
npm run edit       # the same, open to the local network for a session with the artist
npm run build      # the static site, in apps/demo/dist
npm run seed       # regenerates the original demo content (images, film, 3D model)
npm test           # unit tests
npm run test:e2e   # a full editing session in a real browser
```

## A session with the artist

1. `npm run edit` prints a link like `http://192.168.1.20:4321/?edit=ABCD-EFGH`.
2. The artist opens it on their device, on the same Wi-Fi. Their browser is then recognised for thirty days. Anyone who arrives without the link is asked for the code.
3. They make their changes; each save is written to the site's folder:
   - `content/content.json` for the texts and the structure;
   - `public/media/` for files, whatever their format.
4. They publish the site themselves if a command is configured (see below). Otherwise, after the session: review the `git diff`, commit, `npm run build`, deploy `dist/`.

In the editor's toolbar:

- **Edit / Browse**: a click edits, or the site behaves as usual.
- **Content**: everything that can be edited, including what cannot be clicked on the page (content drawn in WebGL, hidden states).
- **Undo**: goes back on the last save (a hundred levels, kept in `.foliome/`, outside git).

### Unsaved changes

While a panel holds changes that are not saved yet, the editor sends them to the server along with its heartbeats (every thirty seconds, and as soon as the tab comes back to the foreground): the path of each changed field and its current value, never files still being uploaded. The server keeps the latest version of each field in `.foliome/drafts.json`.

- Saving the field, or closing the panel without saving, clears its draft.
- If the tab closes, or the server stops, the draft stays. When the artist opens that field again, and if the draft differs from what is saved, the panel offers "Pick up the unsaved changes from November 4 at 6:12 PM?": **Pick up** puts the values back in the panel, **Ignore** clears the draft.
- Only items that already exist have drafts: an item being created has none.

The access code is kept in `.foliome/local.json`; deleting that file and restarting the server makes a new one and closes open sessions. Without the code, the server only serves a page that asks for it: neither the site nor its source code. Only the developer's browser, on the computer running the server, is exempt.

## Remotely, through a tunnel

The artist does not have to be on the same network. A tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel…) gives the development server a public address, as long as the computer is on and the server running. It points to `http://localhost:4321`, and its address must be declared:

```sh
FOLIOME_ADDRESS="https://studio.example.com" npm run dev
```

The terminal then prints the link to send to the artist, like `https://studio.example.com/?edit=ABCD-EFGH`.

Once the address is declared, everyone is asked for the code, including on the developer's computer: what comes through a tunnel comes from that machine too, and nothing tells it apart from the developer's browser. **Never open a tunnel to the server without declaring it.**

In the site's configuration, this is the `address` option; the demo reads it from `FOLIOME_ADDRESS`.

## Making a site editable

Three things, all visible in `apps/demo`.

### 1. Declare the content

In `astro.config.mjs`, `content` describes the content file. There is only one building block, nested at will: fields, grouped in a `group` (a single instance) or a `list` (as many items as the artist wants).

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
        // A list inside each project.
        credits: { type: 'list', label: 'Crédits', itemLabel: 'Crédit', titleField: 'role',
          fields: { role: { type: 'text', label: 'Rôle' }, name: { type: 'text', label: 'Nom' } } },
        // A list with several kinds of items: the artist builds the page block by block.
        sections: { type: 'list', label: 'Sections de la page', types: {
          texte: { label: 'Texte', fields: { text: { type: 'richtext', label: 'Texte' } } },
          galerie: { label: 'Galerie', fields: { files: { type: 'files', label: 'Fichiers' } } },
        } },
      },
    },
  },
})
```

The labels are what the artist sees, so they are in the site's language.

| Type | Content |
|---|---|
| `text`, `longtext` | Text on one line, on several |
| `richtext` | Text with bold, italics and links |
| `select` | One choice among `options` |
| `color` | A `#rrggbb` colour: the system colour picker, the code, and swatches (`swatches`), for instance the site's palette |
| `range` | A number on a slider, from `min` to `max` (`step`, `unit` optional) |
| `file`, `files` | One file, several. `kinds: ['image']` restricts what is accepted |
| `group` | Fields, in a single instance |
| `list` | Items that can be added and reordered: `fields` for a single shape, `types` for several |

On a list: `addLabel` at the top level adds a button to the toolbar; `path` gives each item a page, with a `slug` taken from the title once and for all.

### 2. Read the content

From `@foliome/astro/content`:

| Function | Purpose |
|---|---|
| `getContent({ locale })` | The content, in the page's language |
| `url(asset)`, `srcset(asset)` | The address of a file, and its smaller versions for an image |
| `richText(value)` | The HTML of a `richtext` field, for `set:html` |
| `isEditing()` | True while editing |

### 3. Mark the areas

`<h1 {...edit(`projects.${p.id}.title`)}>`. The path follows the content; in a list, it goes through the item's `id`: `projects.${p.id}.sections.${s.id}.text`. Depending on what it points to, the panel shows a field, a group, a whole list or an item (which can then be moved and deleted). These attributes only exist while editing; the built site keeps no trace of them.

Rendering is up to the site. Two conventions help the editor get along with effects:

- after each save the page is reloaded with the class `foliome-quiet` on `<html>`: the site can use it to skip its intro animation;
- `html[data-foliome-mode="edit"]` is present while Edit mode is on.

A WebGL site that keeps its images in the page, invisible under the canvas, can still be edited by clicking: the editor looks for areas through whatever covers them.

### 4. Show a setting while it is being adjusted (optional)

For a colour or a light, reloading the page on every try makes fine-tuning impossible. While a panel is open, the editor announces each current value on `window`, before anything is saved:

```js
addEventListener('foliome:preview', (e) => {
  const { path, value } = e.detail // for instance 'ambiance.blanc.sun', '#fff4e4'
  if (!path.startsWith('ambiance.')) return
  apply(path, value) // the scene changes at once
  e.preventDefault() // "I have shown it"
})
```

The path is the field's path in the content (for a group, its whole value). The site calls `preventDefault()` on what it managed to apply:

- **Save**: when every changed field has been shown this way, the page is not reloaded. The editor only reads the content again.
- **Cancel**: when the panel is closed without saving, the editor sends back the original values of the fields that were shown.

Whatever the site ignores behaves as before: the page reloads after saving.

## Several languages

`locales: ['fr', 'en']` in the configuration (the first one is the default), then `translate: true` on the text fields concerned. The artist then sees one tab per language in the panel, opened on the page's language (`<html lang>`). `getContent({ locale })` returns the values in the requested language, falling back to the default one. Routes per language are up to the site: the demo serves French at the root and English under `/en`.

The editor itself speaks the language of the artist's browser, French or English, whatever the page's language. Labels written in the site's configuration (`label`, `help`, `addLabel`) are shown as they are.

## Files

On upload, on the computer hosting the session:

- **Images**: rotated upright, stripped of their metadata (GPS position included), scaled down to 3200 px at most, with versions at 640, 1280 and 1920 px. HEIC and TIFF become JPEG.
- **Videos**: re-encoded as MP4 (H.264, 1080p at most) with a poster image. `ffmpeg` must be installed, otherwise they are kept as they are.
- **Everything else** (PDF, 3D models, sounds, archives…): kept as it is.

A file can weigh up to 2 GB. `maxFileSize` (in bytes) lowers this limit for a site, for instance `maxFileSize: 200 * 1024 ** 2`; the editor then refuses a file that is too heavy before even sending it, and says what the limit is.

Only the prepared version is kept: the original stays with the artist. Each file has a `kind` (`image`, `video`, `audio`, `pdf`, `model`, `file`); the site chooses how to render it, see `apps/demo/src/components/Media.astro`.

## Publishing from the editor

`publish: 'npm run deploy'` in the configuration adds a **Publish** button that runs this command from the site's folder. The demo reads it from the `FOLIOME_PUBLISH` variable, so that no deploy command is written into the repository:

```sh
FOLIOME_PUBLISH="npm run build && rsync -a dist/ server:/var/www/site/" npm run edit
```

## Keeping the content in git

On a server the artist uses alone, the `git` option records their work in the site's repository. The demo reads it from the `FOLIOME_GIT` variable:

```js
git: process.env.FOLIOME_GIT ? { push: true } : undefined,
```

- **When**: ten minutes after the last save, before each publish, and when the server stops.
- **What**: `content/` and `public/media/`, nothing else. Code being worked on in the folder is never included, nor a file still being uploaded.
- **Who**: commits are signed `Foliome (site name)`, with no git configuration needed on the machine.
- **With `push`**: whatever is new on the remote is merged first, then the commits are pushed. This needs a tracked branch (`git push -u`) and access without a password, for instance a deploy key.

None of this gets in the artist's way: if it fails, saving and publishing go on, the error shows in the server's terminal and the push is tried again next time.

Once the site is on a server, `content/` belongs to it: editing it by hand elsewhere leads to a conflict, which blocks pushing until it is resolved. The artist's work, meanwhile, stays saved on the server.

## Running Foliome for others: the host API

An editing server can be started, put to sleep and watched by a program next to it, the host: the one that knows how many sites fit on the machine, who gets in and for how long. Foliome knows none in particular. It offers any of them the API below, to stick to; foliome.eu's hosting is one, in a separate repository.

To turn it on, the editing server and the host share a key, `FOLIOME_HOST_KEY` (the `hostKey` option of `createLocal`). Without it, `/_foliome/host` does not exist. Each request carries the header `X-Foliome-Host: <key>` and arrives under the site's public name, with `Origin: https://<public name>` for a `POST`, as the site's own pages would. Without the right key, the answer is a 404.

### What is going on: `GET /_foliome/host`

```json
{
  "idle": 42000, "dirty": true, "editors": 1, "busy": false, "drafted": true,
  "uploads": 0, "publishing": false, "restoring": false,
  "sessions": [{ "id": "9f2c41d07ab3e815", "seen": 12000, "idle": 42000, "dirty": true, "drafted": true }]
}
```

| Field | Meaning |
|---|---|
| `idle` | Milliseconds since the artist's last action, across all sessions |
| `dirty` | An open panel holds unsaved changes |
| `editors` | Open editors, going by their heartbeats (one every thirty seconds) |
| `busy` | A request is in progress, an upload or a publish: stopping now would cut it off |
| `drafted` | Everything unsaved has arrived as a backup draft: closing loses nothing |
| `uploads`, `publishing` | Files being uploaded; publish in progress |
| `restoring` | The content is being brought back to an earlier version (see below) |
| `sessions` | One item per open editor: `id` (to talk to it; `local` for the developer's browser), `seen` (ms since its last heartbeat), `idle`, `dirty`, `drafted` |

### Opening a session: `POST /_foliome/host/grant`

`{ "ms": 600000, "home": "https://example.org/#demo" }` closes every session and prepares one lasting `ms` milliseconds. The answer, `{ "ticket": "…" }`, can be exchanged once, within two minutes, by sending the visitor to `https://<public name>/?ticket=…`: the server sets its session cookie and removes the ticket from the address. A ticket already used or expired leads to the sign-in page. `home` is the address to send back anyone who arrives without a session on a `restricted` site.

### Talking to artists: `POST /_foliome/host/notice`

```json
{
  "notice": {
    "text": { "fr": "Maintenance dans {countdown}. Pensez à enregistrer.", "en": "Maintenance in {countdown}. Remember to save." },
    "level": "warning",
    "in": 600000,
    "actions": [{ "label": { "fr": "Compris", "en": "Got it" } }, { "label": "Service status", "href": "https://example.org/status" }]
  },
  "farewell": { "text": "Editing is closed.", "final": true, "actions": [{ "label": "Reopen", "do": "reload" }] },
  "to": "9f2c41d07ab3e815"
}
```

The editor shows a notice as it is: Foliome gives it no meaning. Closing a session, warning of maintenance or announcing something new are just uses of it.

| Notice field | Meaning |
|---|---|
| `text` | A text, or one per language (`fr`, `en`…): the editor shows the one in the artist's language, otherwise the first. At most 2000 characters |
| `level` | `info` (default), `warning` or `error` |
| `in` | A countdown, in milliseconds from now: `{countdown}` in the text shows the time left ("4 minutes", "less than a minute"), kept up to date, counted on the server's clock |
| `actions` | Up to four buttons, each with its `label`. By default a button dismisses the notice and signals that the artist is there; `"do": "reload"` reloads the page; `"href"` leads to an `http(s)` address |
| `final` | The session is over: the editor stops talking to the server and shows nothing but this notice |
| `untilActive` | The notice goes away as soon as the artist does anything: a remark about their absence, for instance |

- `notice` is shown right away, at the editor's next heartbeat; `null` removes it.
- `farewell` is only shown if the server stops answering and the session is no longer valid: it is what the editor will say if the host stops the server without a last warning, for instance because a sleeping tab would not have heard it. `null` removes it.
- A missing field leaves what was said before unchanged.
- Without `to`, the notice goes to every editor, and replaces what each had received on its own. With `to`, it only goes to that session (404 `no_session` if it does not exist).

### Closing a session: `POST /_foliome/host/close`

`{ "to": "9f2c41d07ab3e815", "notice": { … } }` ends the session at once, or all of them without `to`: its cookie no longer opens anything. What its editor held without saving is not lost: what it had already sent stays as a backup draft, and at its next heartbeat it hands over what it still holds, then shows `notice`, made `final`. The artist will find these drafts when they come back. The answer says how many sessions were closed and whether everything unsaved had already arrived: `{ "ok": true, "closed": 1, "drafted": true }`.

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

### A site lent out: `restricted`

The `restricted: true` option prepares a site to be lent to strangers, for instance a public demo; the demo reads it from `FOLIOME_DEMO`.

- The access code opens nothing: the only way in is a ticket from the host, for a session as long as the host decided.
- No publishing and no git, whatever the configuration.
- 15 MB per file (unless `maxFileSize` says otherwise) and 100 MB in all per session (`restricted: { mediaBudget: … }` in bytes).
- Pages carry `X-Robots-Tag: noindex`.
- Each session granted by the host clears the drafts of the previous one.

## Layout

| Folder | Purpose |
|---|---|
| `packages/core` | Types, paths and operations on the content, file formats, rich text, languages |
| `packages/server` | The editing API, independent of storage; storage on disk; file preparation |
| `packages/editor` | The editor shown on top of the site |
| `packages/astro` | The Astro integration: local editing, access code, reading the content, recording in git |
| `apps/demo` | The reference site |
| `apps/home` | foliome.eu, edited with Foliome like the sites it presents (`npm run home`) |
| `scripts/seed-demo.mjs` | Generates the demo content |
| `tests/e2e.mjs` | The editing session replayed in a browser |

## Not done yet

- Files removed from the content stay in `public/media/`.
- A list with `path` (one page per item) is only supported at the top level of the content.
- Rich text has only been checked in Chrome.
- An item being created has no backup draft.
- The hosted version (remote editing without the developer's computer being on): `packages/server` is designed to take a second storage.
