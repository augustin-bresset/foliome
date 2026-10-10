import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSafeHref, localize, plainText, renderRichText } from '../src/index.ts'

test('formatted text renders as escaped, harmless HTML', () => {
  const html = renderRichText([
    [{ text: 'Un <script>alert(1)</script> & ' }, { text: 'gras', bold: true }, { text: ' puis\nligne', italic: true }],
    [{ text: 'site', href: 'https://exemple.fr/?a=1&b="2"' }, { text: 'piège', href: 'javascript:alert(1)' }, { text: 'interne', href: '/projets/x' }],
    [{ text: '   ' }],
  ])
  assert.equal(
    html,
    '<p>Un &lt;script&gt;alert(1)&lt;/script&gt; &amp; <strong>gras</strong><em> puis<br>ligne</em></p>' +
      '<p><a href="https://exemple.fr/?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener">site</a>piège<a href="/projets/x">interne</a></p>',
  )
  // Plain text written before the field was formatted still renders, paragraph by paragraph.
  assert.equal(renderRichText('Un\n\nDeux <b>'), '<p>Un</p><p>Deux &lt;b&gt;</p>')
  assert.equal(renderRichText(undefined), '')
  assert.equal(isSafeHref('//evil.example'), false)
  assert.equal(isSafeHref(' mailto:a@b.c'), true)
  assert.equal(plainText([[{ text: 'a' }, { text: 'b', bold: true }], [{ text: 'c' }]]), 'ab\n\nc')
})

test('translated values flatten to one language, with a fallback', () => {
  const content = {
    title: { $t: { fr: 'Refuge', en: 'Hut' } },
    summary: { $t: { fr: 'Trente-deux couchages.', en: '' } },
    text: { $t: { fr: [[{ text: 'Bonjour' }]], en: [[{ text: ' ' }]] } },
    year: '2024',
    legacy: 'jamais traduit',
    list: [{ id: 'a', label: { $t: { en: 'Only English' } } }],
  }
  assert.deepEqual(localize(content, 'en', 'fr'), {
    title: 'Hut',
    summary: 'Trente-deux couchages.',
    text: [[{ text: 'Bonjour' }]],
    year: '2024',
    legacy: 'jamais traduit',
    list: [{ id: 'a', label: 'Only English' }],
  })
  assert.equal(localize(content, 'fr', 'fr').list[0]!.label, undefined)
  assert.equal(plainText({ $t: { fr: '', en: 'Hut' } }), 'Hut')
})
