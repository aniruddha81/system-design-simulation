import type MiniSearch from "minisearch";

export const resultTypes = ["lesson", "glossary", "case-study", "component"] as const;
export type SearchDocument = { id: string; type: typeof resultTypes[number]; title: string; description: string; href: string };
export const resultLabels = { lesson: "Lessons", glossary: "Glossary", "case-study": "Case studies", component: "Simulator components" };

export function searchDocuments(index: MiniSearch<SearchDocument>, query: string): SearchDocument[] {
  if (!query.trim()) return [];
  const results = index.search(query.trim());
  return resultTypes.flatMap((type) => results.filter((result) => result.type === type).slice(0, 6).map((result) => ({
    id: String(result.id), type, title: result.title, description: result.description, href: result.href,
  })));
}
