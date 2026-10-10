import type { Doc, Op } from './types.ts'

/**
 * Content paths are dot-separated. Inside an array, a segment is the `id` of
 * an item rather than its index, so a path keeps pointing at the same item
 * when the list is reordered: `projects.p_3fk2.title`.
 */

export class OpError extends Error {}

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function segments(path: string): string[] {
  const parts = typeof path === 'string' ? path.split('.') : []
  if (parts.length === 0 || parts.some((p) => !p || FORBIDDEN.has(p))) {
    throw new OpError(`Invalid path: ${String(path)}`)
  }
  return parts
}

function child(node: unknown, key: string): unknown {
  if (Array.isArray(node)) return node.find((x) => isObj(x) && x.id === key)
  if (isObj(node)) return Object.hasOwn(node, key) ? node[key] : undefined
  return undefined
}

export function getAt(doc: unknown, path: string): unknown {
  let node = doc
  for (const s of segments(path)) {
    node = child(node, s)
    if (node === undefined) return undefined
  }
  return node
}

/** Walks to the container of the last segment, creating missing objects on the way. */
function parentOf(doc: Doc, path: string, create: boolean): { parent: unknown; key: string } {
  const parts = segments(path)
  const key = parts.pop() as string
  let node: unknown = doc
  for (const s of parts) {
    let next = child(node, s)
    if (next === undefined) {
      if (!create || !isObj(node)) throw new OpError(`Nothing at "${s}" in ${path}`)
      next = node[s] = {}
    }
    node = next
  }
  return { parent: node, key }
}

function indexIn(list: unknown[], id: string, path: string): number {
  const i = list.findIndex((x) => isObj(x) && x.id === id)
  if (i === -1) throw new OpError(`No item "${id}" at ${path}`)
  return i
}

function applyOp(doc: Doc, op: Op): void {
  switch (op.op) {
    case 'set': {
      const { parent, key } = parentOf(doc, op.path, true)
      if (Array.isArray(parent)) {
        if (!isObj(op.value) || op.value.id !== key) throw new OpError(`Item at ${op.path} must keep its id`)
        parent[indexIn(parent, key, op.path)] = op.value
      } else if (isObj(parent)) {
        parent[key] = op.value
      } else {
        throw new OpError(`Cannot set ${op.path}`)
      }
      return
    }
    case 'insert': {
      if (!isObj(op.value) || typeof op.value.id !== 'string' || !op.value.id) {
        throw new OpError('Inserted items need an id')
      }
      let list = getAt(doc, op.path)
      if (list === undefined) {
        const { parent, key } = parentOf(doc, op.path, true)
        if (!isObj(parent)) throw new OpError(`Cannot create a list at ${op.path}`)
        list = parent[key] = []
      }
      if (!Array.isArray(list)) throw new OpError(`${op.path} is not a list`)
      if (list.some((x) => isObj(x) && x.id === op.value.id)) throw new OpError(`Duplicate id "${op.value.id}"`)
      const at = op.index === undefined ? list.length : Math.max(0, Math.min(list.length, op.index))
      list.splice(at, 0, op.value)
      return
    }
    case 'remove': {
      const { parent, key } = parentOf(doc, op.path, false)
      if (Array.isArray(parent)) parent.splice(indexIn(parent, key, op.path), 1)
      else if (isObj(parent)) delete parent[key]
      else throw new OpError(`Cannot remove ${op.path}`)
      return
    }
    case 'move': {
      const { parent, key } = parentOf(doc, op.path, false)
      if (!Array.isArray(parent)) throw new OpError(`${op.path} is not in a list`)
      const [item] = parent.splice(indexIn(parent, key, op.path), 1)
      parent.splice(Math.max(0, Math.min(parent.length, op.index)), 0, item)
      return
    }
    default:
      throw new OpError(`Unknown operation: ${String((op as { op?: unknown }).op)}`)
  }
}

/** Applies operations in order, mutating `doc`. Throws OpError and leaves `doc` partially updated on failure. */
export function applyOps(doc: Doc, ops: Op[]): void {
  for (const op of ops) {
    if (!isObj(op)) throw new OpError('Malformed operation')
    applyOp(doc, op)
  }
}
