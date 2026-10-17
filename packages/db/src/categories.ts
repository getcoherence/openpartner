/**
 * Curated program categories for marketplace filtering + display.
 *
 * Single source of truth — the brand admin form, the discover filter,
 * the marketplace page chips, and the Network's offering snapshot all
 * pick from this list. New categories require a coordinated change here
 * + the Network repo's mirror; resist adding too many (a category list
 * stops being useful past ~20 entries — the long tail just becomes
 * "Other").
 *
 * Slug is the wire/storage value. Label is the display string.
 */
export interface ProgramCategory {
  slug: string;
  label: string;
}

export const PROGRAM_CATEGORIES: readonly ProgramCategory[] = [
  { slug: 'saas', label: 'SaaS' },
  { slug: 'ai', label: 'AI' },
  { slug: 'devtools', label: 'Developer tools' },
  { slug: 'marketing', label: 'Marketing' },
  { slug: 'sales', label: 'Sales' },
  { slug: 'ecommerce', label: 'E-commerce' },
  { slug: 'finance', label: 'Finance' },
  { slug: 'education', label: 'Education' },
  { slug: 'productivity', label: 'Productivity' },
  { slug: 'design', label: 'Design' },
  { slug: 'media', label: 'Media & content' },
  { slug: 'analytics', label: 'Analytics' },
  { slug: 'hr', label: 'HR & recruiting' },
  { slug: 'communication', label: 'Communication' },
  { slug: 'security', label: 'Security' },
  { slug: 'other', label: 'Other' },
] as const;

export const PROGRAM_CATEGORY_SLUGS: ReadonlySet<string> = new Set(
  PROGRAM_CATEGORIES.map((c) => c.slug),
);

/** Look up the human label for a slug. Returns the slug verbatim if it's
 *  not in the curated list (keeps a stale value rendering rather than
 *  silently dropping it from the UI). */
export function categoryLabel(slug: string): string {
  return PROGRAM_CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
}
