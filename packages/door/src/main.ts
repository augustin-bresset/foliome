import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { type Control, door, type Limits, type Site } from './door.ts'

// FOLIOME_DOOR_CONFIG names a JSON file:
// { "home": "https://foliome.eu", "sites": [{ "name": "tom.foliome.eu", "port": 4331, "root": "/srv/foliome/tom-conan", "unit": "foliome-site@tom-conan.service" }] }
// FOLIOME_DOOR_KEY is shared with every site's editing server.
const config = JSON.parse(readFileSync(process.env.FOLIOME_DOOR_CONFIG ?? '/etc/foliome/door.json', 'utf8')) as {
  home: string
  sites: Site[]
  limits?: Partial<Limits>
}
const key = process.env.FOLIOME_DOOR_KEY
if (!key) throw new Error('FOLIOME_DOOR_KEY is not set: the sites would not answer the door.')

const run = promisify(execFile)
// Nobody is there to type a password: what the door may do is granted to it by the system.
const systemctl = (...args: string[]) => run('systemctl', ['--no-ask-password', ...args])
const control: Control = {
  awake: (unit) => systemctl('is-active', '--quiet', unit).then(() => true, () => false),
  async start(unit) {
    console.log(`Réveil de ${unit}`)
    await systemctl('start', unit)
  },
  async stop(unit) {
    console.log(`Mise en veille de ${unit}`)
    await systemctl('stop', unit)
  },
}

const { handle, watch } = door({ home: config.home, sites: config.sites, key, control, limits: config.limits })
createServer(handle).listen(Number(process.env.PORT ?? 4330), '127.0.0.1')

let watching = false
setInterval(() => {
  if (watching) return
  watching = true
  watch()
    .catch((err: unknown) => console.error(err))
    .finally(() => {
      watching = false
    })
}, 30_000)
