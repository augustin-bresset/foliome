import type { Asset, Doc } from '@foliome/core'

export class TooLargeError extends Error {}

export interface StoredFile {
  /** URL path the file is served from. */
  path: string
  size: number
}

/**
 * Where a site's content and files live. The local implementation writes to
 * the site's folder; a hosted one would use a database and object storage.
 */
export interface Storage {
  read(): Promise<Doc>
  /** Runs `change` on the current content and saves the result. Calls never interleave; if `change` throws, nothing is saved. */
  update(change: (doc: Doc) => void): Promise<Doc>
  canUndo(): Promise<boolean>
  /** Restores the content as it was before the last update. */
  undo(): Promise<boolean>
  putFile(id: string, name: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<StoredFile>
  /**
   * Makes a stored file fit for the web (resized images, re-encoded video…)
   * and returns what changed about it. Optional: without it files are served
   * as uploaded.
   */
  prepare?(id: string, name: string): Promise<Partial<Asset>>
}
