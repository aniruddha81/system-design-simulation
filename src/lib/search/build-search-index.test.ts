import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import MiniSearch from "minisearch";
import { buildSearchIndex, collectDocuments } from "../../../scripts/build-search-index.mjs";
import { caseStudies } from "@/content/case-studies";
import { loadLessons } from "@/lib/content/loader";
import { searchOptions } from "./options.mjs";
import { resultTypes, searchDocuments, type SearchDocument } from "./index";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { SITE_URL } from "@/lib/content/schema";

const matrix = JSON.parse(readFileSync("content/matrix.json", "utf8")) as { lessons: { id: string; status: string }[] };
const liveIds = matrix.lessons.filter((lesson) => lesson.status === "live").map((lesson) => lesson.id);
const documents = collectDocuments();

describe("build-time search index", () => {
  it("indexes every live lesson, its description and all objectives, excluding planned lessons", () => {
    expect(documents.filter((document) => document.type === "lesson").map((document) => document.id).sort()).toEqual(liveIds.map((id) => `lesson:${id}`).sort());
    for (const lesson of loadLessons().filter((lesson) => liveIds.includes(lesson.id))) {
      const indexed = documents.find((document) => document.id === `lesson:${lesson.id}`)!;
      expect(indexed).toMatchObject({ title: lesson.title, description: lesson.description, href: `/learn/${lesson.track}/${lesson.slug}` });
      for (const objective of lesson.objectives) expect(indexed.objectives).toContain(objective.text);
    }
  });

  it("finds the caching lesson for cache after serializing and lazy-loading", () => {
    const index = MiniSearch.loadJSON<SearchDocument>(JSON.stringify(buildSearchIndex()), searchOptions);
    expect(index.search("cache").some((result) => result.id === "lesson:caching")).toBe(true);
    expect(searchDocuments(index, "cache").some((result) => result.id === "lesson:caching")).toBe(true);
    expect(searchDocuments(index, "   ")).toEqual([]);
  });

  it("uses case-study metadata from the registered studies, all 17 component kinds and glossary terms", () => {
    expect(documents.filter((document) => document.type === "case-study")).toEqual(caseStudies.map((study) => ({ id: `case-study:${study.id}`, type: "case-study", title: study.title, description: study.summary, href: `/case-studies/${study.id}` })));
    expect(documents.filter((document) => document.type === "component")).toHaveLength(17);
    expect(documents).toContainEqual(expect.objectContaining({ id: "glossary:caching:hit rate", href: "/learn/building-blocks/caching" }));
    expect(new Set(documents.map((document) => document.id)).size).toBe(documents.length);
    expect(documents.every((document) => document.href.startsWith("/") && !document.href.startsWith("//"))).toBe(true);
  });

  it("groups results by type and caps each group without breaking score order", () => {
    const index = MiniSearch.loadJSON<SearchDocument>(JSON.stringify(buildSearchIndex()), searchOptions);
    const results = searchDocuments(index, "cache");
    const positions = results.map((result) => resultTypes.indexOf(result.type));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const type of resultTypes) expect(results.filter((result) => result.type === type).length).toBeLessThanOrEqual(6);
    expect(searchDocuments(index, "zzzxqnotaword")).toEqual([]);
  });

  it("keeps the generated public index in sync with the sources", () => {
    expect(JSON.parse(readFileSync("public/search-index.json", "utf8"))).toEqual(JSON.parse(JSON.stringify(buildSearchIndex())));
  });
});

describe("crawler metadata", () => {
  it("lists all live lessons and registered case studies and omits private routes", () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const document of documents.filter((document) => document.type === "lesson" || document.type === "case-study")) {
      expect(urls).toContain(`${SITE_URL}${document.href}`);
    }
    expect(urls.some((url) => /\/(sandbox|dev|settings|progress)(\/|$)/.test(new URL(url).pathname))).toBe(false);
    expect(robots().rules).toMatchObject({ disallow: ["/sandbox", "/dev"] });
  });
});
