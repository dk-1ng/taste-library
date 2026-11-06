import {
  FORMAT_REGISTRY,
  type FileKind,
  type FormatLayout,
  type FormatRegistry,
  type FormatVersionSpec,
} from "../../src/format.js";
import {
  canonicalOrder,
  canonicalText,
  isFileType,
  notCanonicalIssue,
} from "../../src/json/canonical.js";
import { v1ToV2 } from "../migrations/v1-to-v2.js";
import { v2Schemas } from "../schemas/v2/set.js";

/**
 * A test-only registry with a version 2 on top of the production version 1 (docs/design.md
 * section 15, "Core test approach"): real version 2 schemas (`test/schemas/v2/`), a version 2
 * folder layout and the test-only step (`test/migrations/v1-to-v2.ts`), so the reader, the
 * migration and the writer are tested with a real step before the first real one exists.
 * Test-only: it lives outside `src/`, so it can never reach `dist/`.
 */

const v1 = FORMAT_REGISTRY.versions[1];
if (v1 === undefined) throw new Error("The production registry has no version 1.");

const { "glossary.json": _glossary, ...v2TopFiles } = v1.layout.files;

/**
 * Version 1's layout without `glossary.json`, and with a `glossary/` folder of one file per term,
 * each named for the term's id.
 */
const V2_LAYOUT: FormatLayout = {
  files: v2TopFiles,
  flatFolders: { ...v1.layout.flatFolders, glossary: "glossary-term" },
  nestedFolders: v1.layout.nestedFolders,
  identityOf(path, kind) {
    if (kind !== "glossary-term") return v1.layout.identityOf(path, kind);
    const file = path.split("/").pop() ?? "";
    return { name: file.endsWith(".json") ? file.slice(0, -".json".length) : file, field: "id" };
  },
};

/** The schema of a kind of version 2, or a bug in the caller: a kind version 2 does not have. */
function schemaOf(kind: FileKind) {
  const schema = Object.hasOwn(v2Schemas, kind) ? v2Schemas[kind] : undefined;
  if (schema === undefined) throw new Error(`"${kind}" is not a kind of file of version 2.`);
  return schema;
}

/**
 * The canonical value of a parsed version 2 file: the schema's key order, with the lists of the
 * kinds version 1 also has sorted as version 1 sorts them. A term file has no list to sort.
 */
const order = (kind: FileKind, parsed: unknown): unknown =>
  isFileType(kind) ? canonicalOrder(kind, parsed) : parsed;

const canonicalize = (kind: FileKind, value: unknown): unknown =>
  order(kind, schemaOf(kind).parse(value));

const V2: FormatVersionSpec = {
  schemas: v2Schemas,
  layout: V2_LAYOUT,
  canonicalize,
  serialize: (kind, value) => canonicalText(canonicalize(kind, value)),
  canonical: (kind, file, read, parsed) =>
    notCanonicalIssue(file, read, canonicalText(order(kind, parsed))),
};

export const TEST_REGISTRY: FormatRegistry = {
  current: 2,
  versions: { 1: v1, 2: V2 },
  steps: { 1: v1ToV2 },
};
