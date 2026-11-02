import { getContent } from '@foliome/astro/content'

export type Locale = 'fr' | 'en'

// Mirrors the fields declared in astro.config.mjs, translated fields already in the page's language.
export interface Made {
  id: string
  name: string
  role: string
  url: string
}

export async function load(locale: Locale): Promise<{ sites: Made[]; email: string }> {
  const content = await getContent<{ sites?: Partial<Made>[]; contact?: { email?: string } }>({ locale })
  return {
    // A site added a moment ago has empty fields until they are filled in.
    sites: (content.sites ?? []).map((site) => ({ name: '', role: '', url: '', ...site }) as Made),
    email: content.contact?.email ?? '',
  }
}
