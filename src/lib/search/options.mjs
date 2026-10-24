// Shared by the build script and the lazy browser loader; serialization needs identical options.
export const searchOptions = {
  fields: ["title", "description", "objectives"],
  storeFields: ["title", "description", "type", "href"],
  searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.2 },
};
