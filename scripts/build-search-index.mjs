import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import matter from "gray-matter";
import MiniSearch from "minisearch";
import ts from "typescript";
import { searchOptions } from "../src/lib/search/options.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const source = (file) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);

function declaration(file, name) {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const found = statement.declarationList.declarations.find((d) => d.name.getText(file) === name);
    if (found?.initializer) return found.initializer;
  }
  throw new Error(`Missing static declaration: ${name}`);
}

function stringProperty(object, name) {
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`Expected an object containing ${name}`);
  const property = object.properties.find((p) => p.name?.getText().replace(/["']/g, "") === name);
  if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
    throw new Error(`Expected a string literal for ${name}`);
  }
  return property.initializer.text;
}

export function collectDocuments() {
  const documents = [];
  const matrix = JSON.parse(read("content/matrix.json"));
  const live = matrix.lessons.filter((lesson) => lesson.status === "live");
  const lessons = new Map();
  for (const track of new Set(live.map((lesson) => lesson.track))) {
    for (const name of fs.readdirSync(path.join(ROOT, "content/en", track)).filter((name) => name.endsWith(".mdx")).sort()) {
      const file = `content/en/${track}/${name}`;
      const raw = read(file);
      if (!raw.startsWith("{/*")) throw new Error(`${file}: missing frontmatter`);
      const parsed = matter(raw, { delimiters: ["{/*", "*/}"] });
      if (lessons.has(parsed.data.id)) throw new Error(`${file}: duplicate lesson ID`);
      lessons.set(parsed.data.id, { ...parsed, file });
    }
  }
  for (const entry of live) {
    const lesson = lessons.get(entry.id);
    if (!lesson) throw new Error(`Live lesson has no MDX file: ${entry.id}`);
    const { data, content, file } = lesson;
    if (data.track !== entry.track || file !== `content/en/${data.track}/${data.slug}.mdx`) {
      throw new Error(`${file}: frontmatter does not match the curriculum`);
    }
    if (!data.title || !data.description || !Array.isArray(data.objectives) || data.objectives.some((o) => typeof o.text !== "string")) {
      throw new Error(`${file}: missing search metadata`);
    }
    const href = `/learn/${data.track}/${data.slug}`;
    documents.push({ id: `lesson:${data.id}`, type: "lesson", title: data.title, description: data.description, objectives: data.objectives.map((o) => o.text).join(" "), href });

    // Step titles are this MDX format's headings; bold terms add vocabulary such as “hit rate”.
    const terms = [
      ...content.matchAll(/^#{2,4}\s+(.+)$/gm),
      ...content.matchAll(/<Step\s+id="[^"]+"\s+title="([^"]+)"/g),
      ...content.matchAll(/\*\*([^*\n]+)\*\*/g),
    ].map((match) => match[1].replace(/[`*_]/g, "").trim()).filter((term) => term.length >= 3 && term.length <= 80 && /[a-z]/i.test(term));
    for (const [key, term] of new Map(terms.map((term) => [term.toLowerCase(), term]))) {
      documents.push({ id: `glossary:${data.id}:${key}`, type: "glossary", title: term, description: `In ${data.title}`, href });
    }
  }

  // Read literal metadata with the TS parser: no engine code or React UI enters the index builder.
  const registry = source("src/content/case-studies/index.ts");
  const registered = declaration(registry, "caseStudies");
  if (!ts.isArrayLiteralExpression(registered)) throw new Error("caseStudies must be a static array");
  for (const name of registered.elements.map((element) => element.getText(registry))) {
    const imported = registry.statements.find((statement) => ts.isImportDeclaration(statement)
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.namedBindings.elements.some((element) => element.name.text === name));
    if (!imported || !ts.isStringLiteral(imported.moduleSpecifier)) throw new Error(`Missing case study import: ${name}`);
    const object = declaration(source(`src/content/case-studies/${imported.moduleSpecifier.text.slice(2)}.ts`), name);
    const id = stringProperty(object, "id");
    documents.push({ id: `case-study:${id}`, type: "case-study", title: stringProperty(object, "title"), description: stringProperty(object, "summary"), href: `/case-studies/${id}` });
  }

  const engine = source("src/engine/types.ts");
  const kindType = engine.statements.find((statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === "ComponentKind");
  if (!kindType || !ts.isUnionTypeNode(kindType.type)) throw new Error("Missing ComponentKind union");
  const labels = declaration(source("src/components/sandbox/design-ops.ts"), "KIND_LABEL");
  const blurbs = declaration(source("src/components/sandbox/kinds.tsx"), "KIND_BLURB");
  for (const member of kindType.type.types) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) throw new Error("ComponentKind must contain string literals");
    const kind = member.literal.text;
    documents.push({ id: `component:${kind}`, type: "component", title: stringProperty(labels, kind), description: stringProperty(blurbs, kind), href: "/sandbox" });
  }
  if (new Set(documents.map((document) => document.id)).size !== documents.length) throw new Error("Duplicate search document IDs");
  return documents;
}

export function buildSearchIndex() {
  const index = new MiniSearch(searchOptions);
  index.addAll(collectDocuments());
  return index;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const index = buildSearchIndex();
  fs.mkdirSync(path.join(ROOT, "public"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "public/search-index.json"), JSON.stringify(index));
  console.log(`Search index: ${index.documentCount} documents`);
}
