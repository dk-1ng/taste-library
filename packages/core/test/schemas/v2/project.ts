import { ProjectSchema as ProjectV1 } from "../../../src/schemas/v1/project.js";
import { LanguageTag } from "../../../src/schemas/v1/shared.js";
import { atVersion2With } from "./at-version-2.js";

/**
 * `projects/<slug>/project.json` of the test-only version 2: version 1's, with `formatVersion` 2
 * and the library's `language`, which the step copies in (data moved between files), last.
 */
export const ProjectSchema = atVersion2With(ProjectV1, { language: LanguageTag });
