/**
 * Random identifiers (format-spec §4.3; docs/design.md section 3, "Core modules and API"). Pure:
 * the random source and the clock are injectable, and the defaults are the globals that Node and
 * browsers share, used by their bare names.
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Fills the array with random bytes, like `crypto.getRandomValues`. */
export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

export interface IdOptions {
  /** Says whether an id is already taken; a taken id is drawn again. */
  exists?: (id: string) => boolean;
  /** Replaces the cryptographic source (tests). */
  random?: RandomSource;
}

export interface RefIdOptions extends IdOptions {
  /** The clock (tests). */
  now?: () => Date;
}

const MAX_ATTEMPTS = 1000;

const defaultRandom: RandomSource = (bytes) => {
  crypto.getRandomValues(bytes);
};

/**
 * `length` characters of lowercase Crockford base32. The alphabet has 32 symbols and 256 is a
 * multiple of 32, so keeping the low 5 bits of each byte has no bias.
 */
export function randomPart(length: number, random: RandomSource = defaultRandom): string {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  random(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

function draw(make: () => string, exists: ((id: string) => boolean) | undefined): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = make();
    if (!exists?.(id)) return id;
  }
  throw new Error("Could not draw a free identifier: every attempt was already taken.");
}

function prefixed(prefix: string, length: number, options: IdOptions): string {
  return draw(() => `${prefix}${randomPart(length, options.random)}`, options.exists);
}

export const newLibraryId = (options: IdOptions = {}): string => prefixed("lib-", 10, options);
export const newGuardrailId = (options: IdOptions = {}): string => prefixed("gr-", 6, options);
export const newTermId = (options: IdOptions = {}): string => prefixed("term-", 6, options);
export const newStatementId = (options: IdOptions = {}): string => prefixed("st-", 6, options);

/** `YYYYMMDD` of the UTC date of `date`. */
function utcDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/** `ref-<UTC date>-<6 random>`; the date comes from the injected clock. */
export function newRefId(options: RefIdOptions = {}): string {
  const now = options.now ?? (() => new Date());
  return prefixed(`ref-${utcDate(now())}-`, 6, options);
}
