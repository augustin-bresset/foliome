import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeKinds, kindOf, mimeOf, pickerAccept, safeFileName } from '../src/index.ts'

test('files are classified by what a browser can do with them', () => {
  const kind = (name: string, reported = '') => kindOf(mimeOf(name, reported), name)
  assert.equal(kind('photo.JPG', 'image/jpeg'), 'image')
  assert.equal(kind('plan.pdf'), 'pdf')
  assert.equal(kind('maquette.glb'), 'model')
  assert.equal(kind('maquette.fbx', 'application/octet-stream'), 'model')
  assert.equal(kind('film.mov', 'video/quicktime'), 'video')
  assert.equal(kind('voix.mp3'), 'audio')
  assert.equal(kind('scan.tiff', 'image/tiff'), 'file')
  assert.equal(kind('plan.dwg'), 'file')
  assert.equal(kind('archive.zip'), 'file')
  // Formats that call themselves images but that no browser displays.
  assert.equal(kind('photo.heic', 'image/heic'), 'file')
  assert.equal(kind('plan.dwg', 'image/vnd.dwg'), 'file')
  assert.equal(pickerAccept(['image', 'pdf'])?.includes('image/heic'), false)
  assert.equal(pickerAccept(undefined), undefined)
  assert.equal(describeKinds(['image', 'video', 'pdf']).endsWith('une vidéo ou un PDF'), true)
  assert.equal(safeFileName('Façade nord (v2).JPG'), 'Facade-nord-v2.jpg')
  assert.equal(safeFileName('../../etc/passwd'), 'etc-passwd')
  assert.equal(safeFileName('...'), 'fichier')
})
