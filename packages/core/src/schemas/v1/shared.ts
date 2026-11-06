import { z } from "zod";

/**
 * The shared types of format-spec §4, version 1. Frozen with the version (format-spec §15.4): a
 * change here is a new format version. Pure: imports only `zod`, and the globals Node and
 * browsers share (`URL`).
 *
 * Messages say what is expected and never repeat the field name; `validation/zod-issues.ts`
 * prefixes the path ("pins[0].region.w: must be greater than 0."). A rule that is not about the
 * shape of the value (a pattern, a length in code points, a rule across fields) is a custom issue
 * and carries its message; the generic zod issues (type, missing or unknown field, counts and
 * bounds of arrays and numbers, enums) get their message from the mapper.
 */

/** A value that may be anything: the rules across fields run on the raw input (see `crossCheck`). */
export type Loose = Record<string, unknown>;
export const isObject = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const objectOf = (value: unknown): Loose => (isObject(value) ? value : {});
export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
/** A non-negative safe integer, or `undefined`. */
export const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * A rule across the fields of one object. zod skips an object's refinement when a field inside
 * it has the wrong type, which would hide these rules until the types are fixed; this check
 * always runs, so the function receives the raw input and must not trust its shape. It reports a
 * rule only when the values the rule is about are well-formed, so a malformed value is reported
 * once, by its own rule.
 */
export function crossCheck(fn: (value: unknown, ctx: z.RefinementCtx) => void) {
  const check = z.superRefine(fn);
  check._zod.def.when = () => true;
  return check;
}

/** The `params.code` of a custom issue that must not be reported as `schema-violation`. */
export type RuleCode = "duplicate-id" | "broken-local-link";

/** Adds one issue for a broken rule, optionally with a code other than `schema-violation`. */
export function addRuleIssue(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  message: string,
  code?: RuleCode,
): void {
  ctx.addIssue({ code: "custom", path, message, ...(code ? { params: { code } } : {}) });
}

/** Length in Unicode code points (format-spec §4.2), not UTF-16 code units. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

// Control characters are U+0000–U+001F and U+007F–U+009F, which is exactly `\p{Cc}`.
const ANY_CONTROL = /\p{Cc}/u;
const CONTROL_EXCEPT_TAB_AND_LF = /(?![\t\n])\p{Cc}/u;

function lengthMessage(min: number, max: number): string {
  if (min === 0) return `must be at most ${max} characters long.`;
  if (min === max) return `must be exactly ${max} characters long.`;
  return `must be ${min} to ${max} characters long.`;
}

/** `Line<Max>`: 1–Max code points, one line, no control characters at all. */
export function line(max: number): z.ZodType<string> {
  return z.string().superRefine((text, ctx) => {
    const length = codePointLength(text);
    if (length < 1 || length > max) addRuleIssue(ctx, [], lengthMessage(1, max));
    if (ANY_CONTROL.test(text))
      addRuleIssue(ctx, [], "must be a single line without control characters.");
  });
}

/** `Text<Min, Max>`: Min–Max code points; line breaks are `\n`, `\t` is allowed, no other control characters. */
export function text(min: number, max: number): z.ZodType<string> {
  return z.string().superRefine((value, ctx) => {
    const length = codePointLength(value);
    if (length < min || length > max) addRuleIssue(ctx, [], lengthMessage(min, max));
    if (CONTROL_EXCEPT_TAB_AND_LF.test(value)) {
      addRuleIssue(ctx, [], 'must not contain control characters other than "\\n" and "\\t".');
    }
  });
}

/** `Name`: `Line<200>`. */
export const Name = line(200);

/** `Note`: `Text<0, 100000>`. */
export const Note = text(0, 100000);

/** `Tag`: 1–64 code points, one line, no leading or trailing whitespace. */
export const Tag: z.ZodType<string> = z.string().superRefine((value, ctx) => {
  const length = codePointLength(value);
  if (length < 1 || length > 64) addRuleIssue(ctx, [], lengthMessage(1, 64));
  if (ANY_CONTROL.test(value))
    addRuleIssue(ctx, [], "must be a single line without control characters.");
  if (value !== value.trim()) addRuleIssue(ctx, [], "must not start or end with whitespace.");
});

/** The key by which tags and terms are compared: NFC, lowercased with the locale-independent `toLowerCase()` (format-spec §3.1). */
export function comparisonKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/** `TagList`: 0–50 tags, unique by `comparisonKey`. */
export const TagList: z.ZodType<string[]> = z
  .array(Tag)
  .max(50)
  .check(
    crossCheck((tags, ctx) => {
      const seen = new Map<string, number>();
      listOf(tags).forEach((tag, index) => {
        // A tag that breaks its own rules is reported by them, not again as a repeat.
        if (typeof tag !== "string" || !Tag.safeParse(tag).success) return;
        const key = comparisonKey(tag);
        const first = seen.get(key);
        if (first === undefined) seen.set(key, index);
        else
          addRuleIssue(
            ctx,
            [index],
            `must not repeat item ${first} (tags are compared without case or Unicode form).`,
          );
      });
    }),
  );

/** An integer from `min` to `max` (default: the largest safe integer, 2^53 − 1; format-spec §3.2). */
export function integer(min: number, max: number = Number.MAX_SAFE_INTEGER): z.ZodType<number> {
  // Not `.int()`: its issue stops the checks of every object above it (zod marks it as aborting).
  return z
    .number()
    .min(min)
    .max(max)
    .superRefine((value, ctx) => {
      if (!Number.isInteger(value)) addRuleIssue(ctx, [], "must be an integer.");
    });
}

/** A string that must match a pattern; one custom issue with the given message. */
function patterned(pattern: RegExp, message: string): z.ZodType<string> {
  return z.string().superRefine((value, ctx) => {
    if (!pattern.test(value)) addRuleIssue(ctx, [], message);
  });
}

// ---- Timestamps (§4.1) ----

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIMESTAMP_FIELDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;

/**
 * Whether a string is a UTC timestamp with milliseconds that names a real time: exactly the
 * strings that round-trip through `Date` (format-spec §4.1), checked with calendar arithmetic
 * instead, because two `Date` round trips per timestamp were a measurable part of opening a
 * library (measured in #36).
 */
export function isTimestamp(value: string): boolean {
  const match = TIMESTAMP_FIELDS.exec(value);
  if (match === null) return false;
  return (
    isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) < 24 &&
    Number(match[5]) < 60 &&
    Number(match[6]) < 60
  );
}

/** `Timestamp`: UTC with milliseconds, and it must round-trip (this rejects February 30). */
export const Timestamp: z.ZodType<string> = z.string().superRefine((value, ctx) => {
  if (!TIMESTAMP.test(value)) {
    addRuleIssue(
      ctx,
      [],
      'must be a UTC timestamp with milliseconds, like "2026-11-04T12:00:00.000Z".',
    );
    return;
  }
  if (!isTimestamp(value)) {
    addRuleIssue(ctx, [], "must be a date and time that exist.");
  }
});

/** Whether `earlier` is later than `later` — false unless both are well-formed timestamps, so a malformed one is reported only by its own rule. */
export function isAfter(earlier: string, later: string): boolean {
  return isTimestamp(earlier) && isTimestamp(later) && earlier > later;
}

// ---- Identifiers (§4.3) ----

const CROCKFORD = "[0-9a-hjkmnp-tv-z]";

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  return day <= days;
}

const REF_ID = new RegExp(`^ref-(\\d{4})(\\d{2})(\\d{2})-${CROCKFORD}{6}$`);
const REF_ID_FORM = 'like "ref-20261104-k3x9ab"';

/** Why a string is not a `RefId`, or `null` when it is one. */
function refIdProblem(value: string): string | null {
  const match = REF_ID.exec(value);
  if (!match) return `must be a reference id ${REF_ID_FORM}.`;
  if (!isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return "must contain a date that exists.";
  }
  return null;
}

export const LibraryId = patterned(
  new RegExp(`^lib-${CROCKFORD}{10}$`),
  'must be a library id like "lib-7d2k9q4m1x".',
);

export const RefId: z.ZodType<string> = z.string().superRefine((value, ctx) => {
  const problem = refIdProblem(value);
  if (problem) addRuleIssue(ctx, [], problem);
});

/** Whether a string is a valid `RefId`. */
export function isRefId(value: string): boolean {
  return refIdProblem(value) === null;
}

export const GuardrailId = patterned(
  new RegExp(`^gr-${CROCKFORD}{6}$`),
  'must be a guardrail id like "gr-4m8q2z".',
);
export const TermId = patterned(
  new RegExp(`^term-${CROCKFORD}{6}$`),
  'must be a term id like "term-9x2b7c".',
);
export const StatementId = patterned(
  new RegExp(`^st-${CROCKFORD}{6}$`),
  'must be a statement id like "st-1h6v3r".',
);
/** A sequential id: the pattern, and a number that is a safe integer (format-spec §3.2, §4.3). */
function sequential(pattern: RegExp, message: string) {
  const isValid = (value: string): boolean =>
    pattern.test(value) && Number(value.slice(1)) <= Number.MAX_SAFE_INTEGER;
  const schema: z.ZodType<string> = z.string().superRefine((value, ctx) => {
    if (!isValid(value)) addRuleIssue(ctx, [], message);
  });
  return { schema, isValid };
}

const media = sequential(
  /^m[1-9]\d*$/,
  'must be a media id like "m1", with a number up to 2^53 − 1.',
);
const pin = sequential(/^p[1-9]\d*$/, 'must be a pin id like "p3", with a number up to 2^53 − 1.');
const piece = sequential(
  /^p(0|[1-9]\d*)$/,
  'must be a piece id like "p0" or "p2", with a number up to 2^53 − 1.',
);
const direction = sequential(
  /^d[1-9]\d*$/,
  'must be a direction id like "d2", with a number up to 2^53 − 1.',
);
export const MediaId = media.schema;
export const PinId = pin.schema;
export const LocalPieceId = piece.schema;
export const DirectionId = direction.schema;
export const isGuardrailId = (value: string): boolean => GuardrailId.safeParse(value).success;
export const isTermId = (value: string): boolean => TermId.safeParse(value).success;
export const isStatementId = (value: string): boolean => StatementId.safeParse(value).success;
export const isDirectionId = direction.isValid;
export const isMediaId = media.isValid;
export const isPinId = pin.isValid;
export const isPieceId = piece.isValid;

/** The sequence number of a `MediaId`, `PinId`, `LocalPieceId` or `DirectionId` (`m3` → 3). */
export function sequenceNumber(id: string): number {
  return Number(id.slice(1));
}

/** The Windows reserved device names (format-spec §4.3): never a slug. */
export const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** `Slug`: 1–64 characters, never a Windows reserved device name. */
export const Slug: z.ZodType<string> = z.string().superRefine((value, ctx) => {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) || value.length > 64) {
    addRuleIssue(
      ctx,
      [],
      'must be a slug of 1 to 64 characters like "quiet-editorial": lowercase letters, digits and single hyphens.',
    );
  } else if (WINDOWS_RESERVED.has(value)) {
    addRuleIssue(ctx, [], `must not be "${value}", a reserved device name on Windows.`);
  }
});

const PIECE_REF = /^(ref-\d{8}-[0-9a-hjkmnp-tv-z]{6})#(p(?:0|[1-9]\d*))$/;

/** `PieceRef`: `<RefId>#<LocalPieceId>`. */
export const PieceRef: z.ZodType<string> = z.string().superRefine((value, ctx) => {
  const match = PIECE_REF.exec(value);
  if (!match) {
    addRuleIssue(ctx, [], 'must be a piece reference like "ref-20261104-k3x9ab#p2".');
    return;
  }
  if (refIdProblem(match[1] as string) !== null)
    addRuleIssue(ctx, [], "must contain a date that exists.");
});

export const AgentLabel = patterned(
  /^[a-z0-9][a-z0-9._-]{0,63}$/,
  'must be an agent label of 1 to 64 characters like "claude-code".',
);

// ---- Checksums (§4.4), URLs (§4.5), languages (§5.1) ----

export const Sha256 = patterned(/^[0-9a-f]{64}$/, "must be 64 lowercase hexadecimal characters.");

/** `HttpUrl`: absolute `http:` or `https:`, at most 2048 characters, equal to its WHATWG `href`, no user name or password. */
export const HttpUrl: z.ZodType<string> = z.string().superRefine((value, ctx) => {
  if (codePointLength(value) > 2048) {
    addRuleIssue(ctx, [], "must be at most 2048 characters long.");
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    addRuleIssue(ctx, [], "must be an absolute http or https URL.");
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    addRuleIssue(ctx, [], "must be an absolute http or https URL.");
  } else if (url.username !== "" || url.password !== "") {
    addRuleIssue(ctx, [], "must not contain a user name or password.");
  } else if (url.href !== value) {
    addRuleIssue(ctx, [], `must be written in its normalized form "${url.href}".`);
  }
});

export const LanguageTag = patterned(
  /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/,
  'must be a language tag like "en" or "pt-BR".',
);

// ---- Authored values (§4.6) and reviewed links (§4.7) ----

const REVIEW_STATUS = ["to-review", "accepted", "corrected", "rejected"] as const;
const LINK_STATUS = ["to-review", "accepted", "rejected"] as const;

/**
 * `Authored<T>`. `inputSha256` is `"required"` in a piece interpretation (§4.6, §7.6) and
 * `"null"` everywhere else.
 */
export function authored<T extends z.ZodType>(
  content: T,
  options: { inputSha256: "required" | "null" },
) {
  const inputSha256 =
    options.inputSha256 === "required"
      ? Sha256.nullable().superRefine((value, ctx) => {
          if (value === null) addRuleIssue(ctx, [], "must not be null in a piece interpretation.");
        })
      : z.null();
  const user = z.strictObject({
    origin: z.literal("user"),
    content,
    writtenAt: Timestamp,
  });
  const agent = z
    .strictObject({
      origin: z.literal("agent"),
      proposedBy: AgentLabel,
      proposedAt: Timestamp,
      inputSha256,
      proposal: content,
      status: z.enum(REVIEW_STATUS),
      correction: content.nullable(),
      reviewedAt: Timestamp.nullable(),
    })
    .check(
      crossCheck((raw, ctx) => {
        const value = objectOf(raw);
        const status = stringOf(value.status);
        if (status === "corrected" && value.correction === null) {
          addRuleIssue(ctx, ["correction"], 'must not be null when status is "corrected".');
        } else if (
          content.safeParse(value.correction).success &&
          status !== undefined &&
          REVIEW_STATUS.includes(status as (typeof REVIEW_STATUS)[number]) &&
          status !== "corrected"
        ) {
          addRuleIssue(ctx, ["correction"], 'must be null unless status is "corrected".');
        }
        checkReview(ctx, value, REVIEW_STATUS);
      }),
    );
  return z.discriminatedUnion("origin", [user, agent]);
}

/** `ReviewedLink<K>`. */
export function reviewedLink<K extends z.ZodType>(target: K) {
  const user = z.strictObject({
    target,
    origin: z.literal("user"),
    addedAt: Timestamp,
  });
  const agent = z
    .strictObject({
      target,
      origin: z.literal("agent"),
      proposedBy: AgentLabel,
      proposedAt: Timestamp,
      status: z.enum(LINK_STATUS),
      reviewedAt: Timestamp.nullable(),
    })
    .check(crossCheck((value, ctx) => checkReview(ctx, objectOf(value), LINK_STATUS)));
  return z.discriminatedUnion("origin", [user, agent]);
}

/** `reviewedAt` is `null` if and only if the status is `to-review`, and not earlier than `proposedAt`. */
function checkReview(ctx: z.RefinementCtx, value: Loose, allowed: readonly string[]): void {
  const status = stringOf(value.status);
  if (status === undefined || !allowed.includes(status)) return;
  const { reviewedAt } = value;
  if (status === "to-review") {
    if (typeof reviewedAt === "string" && isTimestamp(reviewedAt)) {
      addRuleIssue(ctx, ["reviewedAt"], 'must be null when status is "to-review".');
    }
  } else if (reviewedAt === null) {
    addRuleIssue(ctx, ["reviewedAt"], 'must not be null unless status is "to-review".');
  } else if (
    typeof reviewedAt === "string" &&
    isAfter(stringOf(value.proposedAt) ?? "", reviewedAt)
  ) {
    addRuleIssue(ctx, ["reviewedAt"], "must not be earlier than proposedAt.");
  }
}
