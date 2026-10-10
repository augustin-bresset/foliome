import { type Asset, getContent, type RichText } from '@foliome/astro/content'
import type { Locale } from './i18n'

// Mirrors the fields declared in astro.config.mjs, as pages receive them:
// translated fields already flattened to the page's language.
export type Section =
  | { id: string; type: 'texte'; text: RichText | string }
  | { id: string; type: 'galerie'; files: Asset[] }
  | { id: string; type: 'citation'; quote: string; author: string }

export interface Project {
  id: string
  slug: string
  title: string
  year: string
  place: string
  program: string
  surface: string
  summary: string
  cover: Asset | null
  credits: { id: string; role: string; name: string }[]
  sections: Section[]
}

export interface Site {
  name: string
  baseline: string
  about: RichText | string
  portrait: Asset | null
  contact: { address: string; email: string; phone: string }
}

const EMPTY_SITE: Site = { name: '', baseline: '', about: '', portrait: null, contact: { address: '', email: '', phone: '' } }

export async function load(locale: Locale): Promise<{ site: Site; projects: Project[] }> {
  const content = await getContent<{ site?: Partial<Site>; projects?: Partial<Project>[] }>({ locale })
  return {
    site: { ...EMPTY_SITE, ...content.site, contact: { ...EMPTY_SITE.contact, ...content.site?.contact } },
    // A project created a moment ago may not have every list yet.
    projects: (content.projects ?? []).map((p) => ({ credits: [], sections: [], cover: null, ...p }) as Project),
  }
}
