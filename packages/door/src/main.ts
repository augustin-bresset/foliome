import { createServer } from 'node:http'
import { door } from './door.ts'

// FOLIOME_SITES="tom.foliome.eu=4331,ulysse.foliome.eu=4332"
const sites = Object.fromEntries(
  (process.env.FOLIOME_SITES ?? '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [name, port] = entry.split('=')
      return [name, Number(port)]
    }),
)

createServer(door({ home: process.env.FOLIOME_HOME ?? '', sites })).listen(Number(process.env.PORT ?? 4330), '127.0.0.1')
