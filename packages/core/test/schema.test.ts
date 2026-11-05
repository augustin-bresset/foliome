import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyItem, emptyValue, itemUrl, type ListDef, misfits, resolvePath, type Schema, uniqueSlug, withSlugs } from '../src/index.ts'

const projects: ListDef = {
  type: 'list',
  label: 'Projets',
  itemLabel: 'Projet',
  titleField: 'title',
  path: '/projets/{slug}',
  fields: {
    title: { type: 'text', label: 'Titre' },
    credits: {
      type: 'list',
      label: 'Crédits',
      itemLabel: 'Crédit',
      titleField: 'role',
      fields: { role: { type: 'text', label: 'Rôle' }, name: { type: 'text', label: 'Nom' } },
    },
    sections: {
      type: 'list',
      label: 'Sections',
      types: {
        texte: { label: 'Texte', fields: { text: { type: 'richtext', label: 'Texte' } } },
        citation: { label: 'Citation', titleField: 'author', fields: { quote: { type: 'longtext', label: 'Citation' }, author: { type: 'text', label: 'Auteur' } } },
      },
    },
  },
}

const schema: Schema = {
  content: {
    site: {
      type: 'group',
      label: 'Atelier',
      fields: {
        name: { type: 'text', label: 'Nom' },
        contact: { type: 'group', label: 'Contact', fields: { email: { type: 'text', label: 'E-mail' } } },
      },
    },
    projects,
  },
}

const doc = {
  site: { name: 'Atelier', contact: { email: 'a@b.c' } },
  projects: [
    {
      id: 'p1',
      slug: 'refuge',
      title: 'Refuge',
      credits: [{ id: 'c1', role: 'Charpente', name: 'Scierie du Giffre' }],
      sections: [
        { id: 's1', type: 'texte', text: [[{ text: 'Bonjour' }]] },
        { id: 's2', type: 'citation', quote: 'On y mange face à la combe.', author: 'Le gardien' },
        { id: 's3', type: 'inconnu' },
      ],
    },
  ],
}

test('paths resolve at any depth', () => {
  const group = resolvePath(schema, doc, 'site')
  assert.equal(group?.kind === 'field' && group.def.type, 'group')

  const nested = resolvePath(schema, doc, 'site.contact.email')
  assert.equal(nested?.kind === 'field' && nested.value, 'a@b.c')
  assert.deepEqual(nested?.trail.map((c) => c.label), ['Atelier', 'Contact'])

  const list = resolvePath(schema, doc, 'projects')
  assert.equal(list?.kind === 'field' && list.def.type, 'list')

  const item = resolvePath(schema, doc, 'projects.p1')
  assert.equal(item?.kind === 'item' && item.type.label, 'Projet')
  assert.equal(item?.kind === 'item' && item.count, 1)

  const credit = resolvePath(schema, doc, 'projects.p1.credits.c1.name')
  assert.equal(credit?.kind === 'field' && credit.value, 'Scierie du Giffre')
  assert.deepEqual(credit?.trail.map((c) => `${c.kind}:${c.label}`), ['list:Projets', 'item:Refuge', 'list:Crédits', 'item:Charpente'])
})

test('items of a typed list take the shape of their type', () => {
  const quote = resolvePath(schema, doc, 'projects.p1.sections.s2')
  assert.equal(quote?.kind === 'item' && quote.type.label, 'Citation')
  assert.equal(quote?.kind === 'item' && quote.index, 1)
  assert.equal(resolvePath(schema, doc, 'projects.p1.sections.s2.author')?.kind, 'field')
  // A field of another type, an unknown type, an unknown item, an unknown field.
  assert.equal(resolvePath(schema, doc, 'projects.p1.sections.s2.text'), null)
  assert.equal(resolvePath(schema, doc, 'projects.p1.sections.s3'), null)
  assert.equal(resolvePath(schema, doc, 'projects.zzz.title'), null)
  assert.equal(resolvePath(schema, doc, 'site.nope'), null)
  assert.equal(resolvePath(schema, doc, 'site.name.deeper'), null)
})

test('new items start empty and page items get a lasting slug', () => {
  const sections = projects.fields!.sections as ListDef
  const block = emptyItem(sections, 'citation')
  assert.deepEqual({ ...block, id: 'x' }, { id: 'x', type: 'citation', quote: '', author: '' })
  assert.equal(emptyItem(sections, 'nope'), null)
  assert.deepEqual({ ...emptyItem(projects), id: 'x' }, { id: 'x', title: '', credits: [], sections: [] })
  assert.deepEqual(emptyValue(schema.content.site!), { name: '', contact: { email: '' } })

  const slugged = withSlugs(projects, [
    { id: 'a', slug: 'refuge', title: 'Renommé depuis' },
    { id: 'b', title: 'Refuge' },
    { id: 'c', title: '' },
  ])
  assert.deepEqual(slugged.map((p) => p.slug), ['refuge', 'refuge-2', 'projet'])
  assert.equal(itemUrl(projects, slugged[1]!), '/projets/refuge-2')
  assert.equal(uniqueSlug('Maison à Annecy', ['maison-a-annecy']), 'maison-a-annecy-2')
})

test('content of the wrong shape is found, missing values and unknown fields are not', () => {
  const known = { ...doc, projects: doc.projects.map((p) => ({ ...p, sections: p.sections.filter((s) => s.type !== 'inconnu') })) }
  assert.deepEqual(misfits(schema.content, known), [])
  assert.deepEqual(misfits(schema.content, {}), [])
  assert.deepEqual(misfits(schema.content, { site: { name: { $t: { fr: 'Atelier', en: 'Studio' } } }, older: 'kept', projects: [{ id: 'p1' }] }), [])
  assert.deepEqual(misfits(schema.content, doc), ['projects.p1.sections.s3'])
  assert.deepEqual(misfits(schema.content, []), ['(content)'])
  assert.deepEqual(
    misfits(schema.content, { site: { name: 3, contact: 'a@b.c' }, projects: { p1: {} } }),
    ['site.name', 'site.contact', 'projects'],
  )
  assert.deepEqual(misfits(schema.content, { projects: [{ title: 'Sans id' }, { id: 'p2', credits: [{ id: 'c1', role: ['Charpente'] }] }] }), ['projects', 'projects.p2.credits.c1.role'])
})
