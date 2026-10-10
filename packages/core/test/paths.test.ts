import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyOps, getAt, OpError } from '../src/index.ts'

const doc = () => ({
  site: { title: 'Atelier' },
  projects: [
    { id: 'a', slug: 'a', title: 'A', media: [{ id: 'm1' }, { id: 'm2' }] },
    { id: 'b', slug: 'b', title: 'B', media: [] },
  ],
})

test('paths address list items by id', () => {
  const d = doc()
  assert.equal(getAt(d, 'projects.b.title'), 'B')
  assert.equal(getAt(d, 'projects.zzz.title'), undefined)
  assert.equal(getAt(d, 'site.title'), 'Atelier')
})

test('set, insert, remove and move', () => {
  const d = doc()
  applyOps(d, [
    { op: 'set', path: 'projects.b.title', value: 'B2' },
    { op: 'set', path: 'site.contact.email', value: 'x@y.z' },
    { op: 'insert', path: 'projects', value: { id: 'c', title: 'C' }, index: 0 },
    { op: 'move', path: 'projects.a', index: 2 },
    { op: 'remove', path: 'projects.a.media.m1' },
    { op: 'insert', path: 'tags', value: { id: 't1' } },
  ])
  assert.deepEqual(d.projects.map((p) => p.id), ['c', 'b', 'a'])
  assert.equal(getAt(d, 'projects.b.title'), 'B2')
  assert.equal(getAt(d, 'site.contact.email'), 'x@y.z')
  assert.deepEqual(getAt(d, 'projects.a.media'), [{ id: 'm2' }])
  assert.deepEqual(getAt(d, 'tags'), [{ id: 't1' }])
})

test('invalid operations are refused', () => {
  const refuse = (ops: Parameters<typeof applyOps>[1]) => assert.throws(() => applyOps(doc(), ops), OpError)
  refuse([{ op: 'set', path: '__proto__.polluted', value: true }])
  refuse([{ op: 'set', path: 'site.constructor.prototype.x', value: true }])
  refuse([{ op: 'set', path: '', value: 1 }])
  refuse([{ op: 'insert', path: 'projects', value: { id: 'a' } }])
  refuse([{ op: 'insert', path: 'site', value: { id: 'x' } }])
  refuse([{ op: 'remove', path: 'projects.zzz' }])
  refuse([{ op: 'move', path: 'site.title', index: 0 }])
  refuse([{ op: 'set', path: 'projects.a', value: { id: 'other' } }])
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})
