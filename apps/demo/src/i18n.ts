// Interface words that are part of the site's code, not of its editable content.
export type Locale = 'fr' | 'en'

const UI = {
  fr: {
    projects: 'Projets',
    studio: 'Atelier',
    theStudio: 'L’atelier',
    next: 'Projet suivant',
    place: 'Lieu',
    year: 'Année',
    program: 'Programme',
    surface: 'Surface',
    empty: 'Aucun projet pour l’instant.',
    notFound: 'Cette page n’existe pas, ou le projet a été retiré.',
    back: 'Retour aux projets',
    switchTo: 'English',
  },
  en: {
    projects: 'Projects',
    studio: 'Studio',
    theStudio: 'The studio',
    next: 'Next project',
    place: 'Place',
    year: 'Year',
    program: 'Programme',
    surface: 'Area',
    empty: 'No projects yet.',
    notFound: 'This page does not exist, or the project was removed.',
    back: 'Back to projects',
    switchTo: 'Français',
  },
} as const

export const ui = (locale: Locale) => UI[locale]

/** Address of a page in a language: French at the root, English under /en. */
export const link = (locale: Locale, path: string) => (locale === 'fr' ? path : `/en${path === '/' ? '' : path}`)

/** The same page in the other language. */
export function twin(locale: Locale, pathname: string): string {
  if (locale === 'fr') return link('en', pathname)
  return pathname.replace(/^\/en(?=\/|$)/, '') || '/'
}
