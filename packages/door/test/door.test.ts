import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createLocal } from '../../astro/src/local.ts'
import { door } from '../src/door.ts'

const HOME = 'https://foliome.example'
const closing: (() => Promise<unknown>)[] = []
after(() => Promise.all(closing.map((close) => close())))

const listen = async (server: http.Server) => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  closing.push(async () => {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  })
  return (server.address() as AddressInfo).port
}

/** A site's real editing server, reached under its public name. */
async function site(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foliome-door-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'editor.js'), '')
  const local = await createLocal({ root, name, schema: { content: {} }, allowedHosts: [], address: new URL(`https://${name}`), editorFile: path.join(root, 'editor.js'), onChange: () => {} })
  const port = await listen(http.createServer((req, res) => local.gate(req, res, () => local.middleware(req, res, () => res.end('site')))))
  return { name, port, code: local.code, sessions: async () => Object.keys(JSON.parse(await readFile(path.join(root, '.foliome', 'local.json'), 'utf8')).sessions) }
}

async function entrance(sites: Record<string, number>) {
  const port = await listen(http.createServer(door({ home: HOME, sites })))
  return (body: unknown, { visitor = '203.0.113.7', origin = HOME, method = 'POST', url = '/entrer' } = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': visitor },
      body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    })
}

test('a code leads to the site it opens, and leaves nothing behind', async () => {
  const [tom, ulysse] = await Promise.all([site('tom.example'), site('ulysse.example')])
  const enter = await entrance({ [tom.name]: tom.port, [ulysse.name]: ulysse.port })

  const first = await enter({ code: tom.code })
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { url: `https://tom.example/?edit=${tom.code}` })
  const second = await enter({ code: ulysse.code })
  assert.deepEqual(await second.json(), { url: `https://ulysse.example/?edit=${ulysse.code}` })
  assert.deepEqual(await tom.sessions(), [])
  assert.deepEqual(await ulysse.sessions(), [])
})

test('a wrong code is refused, and tries run out on every site at once', async () => {
  const [tom, ulysse] = await Promise.all([site('tom.example'), site('ulysse.example')])
  const enter = await entrance({ [tom.name]: tom.port, [ulysse.name]: ulysse.port })
  for (let i = 0; i < 8; i++) assert.equal((await enter({ code: 'AAAABBBB' })).status, 401)
  assert.equal((await enter({ code: 'AAAABBBB' })).status, 429)
  assert.equal((await enter({ code: tom.code })).status, 429)
  // The artist, elsewhere, is not shut out by it.
  assert.equal((await enter({ code: tom.code }, { visitor: '198.51.100.4' })).status, 200)
})

test('a site that is down does not pass for a wrong code', async () => {
  const tom = await site('tom.example')
  const enter = await entrance({ 'stopped.example': 1, [tom.name]: tom.port })
  assert.equal((await enter({ code: tom.code })).status, 200)
  assert.equal((await enter({ code: 'AAAABBBB' })).status, 503)
})

test('only the home page may ask, and only for this', async () => {
  const tom = await site('tom.example')
  const enter = await entrance({ [tom.name]: tom.port })
  assert.equal((await enter({ code: tom.code }, { origin: 'https://elsewhere.example' })).status, 403)
  assert.equal((await enter({ code: tom.code }, { url: '/autre' })).status, 404)
  assert.equal((await enter(null, { method: 'GET' })).status, 404)
  assert.equal((await enter('not json')).status, 400)
  assert.equal((await enter({ code: 12 })).status, 400)
  assert.equal((await enter({ code: 'A'.repeat(4096) })).status, 413)
})
