// Pure search helpers for searchable dropdowns (used by ThemedSelect
// when `searchable` is on). No DOM, no React, so they are unit-testable
// on their own. The selected value and the search query stay separate:
// these functions only ever return real options from the dataset — the
// typed query itself is never an option and is never submitted as a
// value. Filtering is case-insensitive, partial, and ignores leading /
// trailing spaces; results are de-duplicated by value.

export interface SearchableOption {
  value: string;
  label: string;
}

export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

// Options whose label contains the query (partial match). An empty
// query returns the full list, de-duplicated by value, in original
// order. The full dataset is searched — nothing is hardcoded here.
export function filterSearchOptions<T extends SearchableOption>(
  options: T[],
  query: string,
): T[] {
  const q = normalizeSearchQuery(query);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const opt of options) {
    if (seen.has(opt.value)) continue;
    seen.add(opt.value);
    if (!q || opt.label.toLowerCase().includes(q)) out.push(opt);
  }
  return out;
}

// The option whose label equals the query exactly (case-insensitive,
// trimmed) — the only thing Enter may select without arrow navigation.
// A partial query ("ind") is NOT an exact match for "India".
export function findExactMatch<T extends SearchableOption>(
  options: T[],
  query: string,
): T | undefined {
  const q = normalizeSearchQuery(query);
  if (!q) return undefined;
  return options.find((o) => o.label.toLowerCase() === q);
}
