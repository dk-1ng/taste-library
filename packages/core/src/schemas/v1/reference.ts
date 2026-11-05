import { z } from "zod";
import {
  addRuleIssue,
  authored,
  countOf,
  crossCheck,
  DirectionId,
  HttpUrl,
  integer,
  isAfter,
  isRefId,
  type Loose,
  listOf,
  objectOf,
  LocalPieceId,
  MediaId,
  Note,
  PinId,
  RefId,
  Sha256,
  sequenceNumber,
  Slug,
  stringOf,
  TagList,
  text,
  Timestamp,
} from "./shared.js";

/** The reference file (format-spec §7, version 1). */

/** The file extension of each media type (format-spec §6.2). */
const EXTENSION = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
} as const;

const IMAGE_TYPES = ["image/webp", "image/png", "image/jpeg", "image/avif"] as const;
const MEDIA_TYPES = [...IMAGE_TYPES, "video/mp4", "video/webm"] as const;

/** Tolerance when comparing proportions (format-spec §7.3). */
const REGION_TOLERANCE = 1e-9;

const MEDIA_ID = /^m[1-9]\d*$/;
const PIN_ID = /^p[1-9]\d*$/;
const PIECE_ID = /^p(0|[1-9]\d*)$/;
const MEDIA_PATH =
  /^ref-\d{8}-[0-9a-hjkmnp-tv-z]{6}\/m[1-9]\d*(-t(0|[1-9]\d*))?\.(webp|png|jpg|avif|mp4|webm)$/;

/** `MediaPath` (format-spec §6.2): `<RefId>/m<n>[-t<ms>].<ext>`. */
const MediaPath: z.ZodType<string> = z.string().superRefine((value, ctx) => {
  if (!MEDIA_PATH.test(value)) {
    addRuleIssue(ctx, [], 'must be a media path like "ref-20261104-k3x9ab/m1.webp".');
  }
});

const Frame = z.strictObject({
  timeMs: integer(0),
  file: MediaPath,
  type: z.enum(IMAGE_TYPES),
  bytes: integer(1),
  sha256: Sha256,
  width: integer(1, 1000000),
  height: integer(1, 1000000),
});

const Media = z
  .strictObject({
    id: MediaId,
    kind: z.enum(["image", "page", "video"]),
    file: MediaPath,
    type: z.enum(MEDIA_TYPES),
    bytes: integer(1),
    sha256: Sha256,
    width: integer(1, 1000000),
    height: integer(1, 1000000),
    durationMs: integer(1).nullable(),
    frames: z.array(Frame).max(1000),
  })
  .check(
    crossCheck((raw, ctx) => {
      const media = objectOf(raw);
      const kind = stringOf(media.kind);
      if (kind !== "image" && kind !== "page" && kind !== "video") return;
      const isVideo = kind === "video";
      const type = stringOf(media.type);
      if (type !== undefined && type in EXTENSION) {
        if (isVideo && !type.startsWith("video/")) {
          addRuleIssue(ctx, ["type"], 'must be a video type when kind is "video".');
        } else if (!isVideo && !type.startsWith("image/")) {
          addRuleIssue(ctx, ["type"], `must be an image type when kind is "${kind}".`);
        }
      }
      const duration = media.durationMs;
      if (isVideo && duration === null) {
        addRuleIssue(ctx, ["durationMs"], 'must not be null when kind is "video".');
      } else if (!isVideo && typeof duration === "number") {
        addRuleIssue(ctx, ["durationMs"], 'must be null unless kind is "video".');
      }
      const frames = listOf(media.frames);
      if (!isVideo) {
        if (frames.length > 0) {
          addRuleIssue(ctx, ["frames"], 'must be empty unless kind is "video".');
        }
        return; // frames of an image are reported once, as a whole
      }
      const firstAt = new Map<number, number>();
      frames.forEach((frame, index) => {
        const timeMs = countOf(objectOf(frame).timeMs);
        if (timeMs === undefined) return;
        const first = firstAt.get(timeMs);
        if (first !== undefined) {
          addRuleIssue(
            ctx,
            ["frames", index, "timeMs"],
            `must not repeat frames[${first}].timeMs.`,
          );
        } else {
          firstAt.set(timeMs, index);
        }
        if (typeof duration === "number" && timeMs > duration) {
          addRuleIssue(
            ctx,
            ["frames", index, "timeMs"],
            `must not be greater than durationMs (${duration}).`,
          );
        }
      });
    }),
  );

const Region = z
  .strictObject({
    x: z.number().min(0),
    y: z.number().min(0),
    w: z.number().gt(0),
    h: z.number().gt(0),
  })
  .check(
    crossCheck((raw, ctx) => {
      const { x, y, w, h } = objectOf(raw);
      const finite = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value);
      if (finite(x) && finite(w) && x + w > 1 + REGION_TOLERANCE) {
        addRuleIssue(ctx, ["w"], "must not reach beyond the right edge: x + w must be at most 1.");
      }
      if (finite(y) && finite(h) && y + h > 1 + REGION_TOLERANCE) {
        addRuleIssue(ctx, ["h"], "must not reach beyond the bottom edge: y + h must be at most 1.");
      }
    }),
  );

const Pin = z.strictObject({
  id: PinId,
  mediaId: MediaId,
  frameMs: integer(0).nullable(),
  region: Region,
  polarity: z.enum(["positive", "negative"]),
  note: Note,
  createdAt: Timestamp,
});

/**
 * A record whose keys are checked by a schema. `z.record` skips a key such as `__proto__` without
 * a word, and the user's data is refused, never altered, so that key is refused first.
 */
function recordOf<K extends z.core.$ZodRecordKey, V extends z.ZodType>(key: K, value: V) {
  const guard = z.unknown().superRefine((input, ctx) => {
    if (typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")) {
      addRuleIssue(ctx, ["__proto__"], "is not a valid key.");
    }
  });
  return guard.pipe(z.record(key, value));
}

const PieceInterpretation = z.strictObject({
  summary: text(1, 2000),
  vocabulary: TagList,
  keywords: TagList,
  screenTypes: TagList,
  components: TagList,
  aspects: TagList,
});

export const ReferenceSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    id: RefId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    source: z.strictObject({
      via: z.enum(["paste", "drop", "file-picker", "url-capture"]),
      url: HttpUrl.nullable(),
    }),
    result: z
      .strictObject({
        project: Slug,
        direction: DirectionId.nullable(),
      })
      .nullable(),
    media: z.array(Media).min(1).max(50),
    note: Note,
    pins: z.array(Pin).max(500),
    interpretations: recordOf(
      LocalPieceId,
      authored(PieceInterpretation, { inputSha256: "required" }),
    ),
    lastIssued: z.strictObject({
      media: integer(1),
      pin: integer(0),
    }),
  })
  .check(
    crossCheck((raw, ctx) => {
      const reference = objectOf(raw);
      const id = stringOf(reference.id) ?? "";
      if (isAfter(stringOf(reference.createdAt) ?? "", stringOf(reference.updatedAt) ?? "")) {
        addRuleIssue(ctx, ["updatedAt"], "must not be earlier than createdAt.");
      }
      const source = objectOf(reference.source);
      if (source.via === "url-capture" && source.url === null) {
        addRuleIssue(ctx, ["source", "url"], 'must not be null when via is "url-capture".');
      }
      const media = Array.isArray(reference.media) ? checkMedia(id, reference, ctx) : undefined;
      checkPins(reference, media, ctx);
      checkInterpretations(reference, ctx);
      checkCounters(reference, ctx);
    }),
  );

/** What the pins need to know about a media item with a well-formed id. */
type MediaFacts = { kind: string | undefined; frameTimes: Set<number> };

function checkMedia(
  refId: string,
  reference: Loose,
  ctx: z.RefinementCtx,
): Map<string, MediaFacts> {
  const byId = new Map<string, MediaFacts>();
  const idIsValid = isRefId(refId);
  listOf(reference.media).forEach((raw, index) => {
    const media = objectOf(raw);
    const id = stringOf(media.id);
    if (id === undefined || !MEDIA_ID.test(id)) return;
    if (byId.has(id)) {
      addRuleIssue(
        ctx,
        ["media", index, "id"],
        `${JSON.stringify(id)} is used by more than one media item.`,
        "duplicate-id",
      );
      return;
    }
    const frames = listOf(media.frames);
    byId.set(id, {
      kind: stringOf(media.kind),
      frameTimes: new Set(
        frames.map((frame) => countOf(objectOf(frame).timeMs)).filter((t) => t !== undefined),
      ),
    });

    // The expected names are built from the ids, so a malformed id or path is reported once, by
    // its own rule, and not again as a name that does not match.
    if (!idIsValid) return;
    const type = stringOf(media.type);
    const file = stringOf(media.file);
    if (type !== undefined && type in EXTENSION && file !== undefined && MEDIA_PATH.test(file)) {
      const expected = `${refId}/${id}.${EXTENSION[type as keyof typeof EXTENSION]}`;
      if (file !== expected) {
        addRuleIssue(
          ctx,
          ["media", index, "file"],
          `must be "${expected}" (<reference id>/<media id>.<extension of the type>).`,
        );
      }
    }
    if (media.kind !== "video") return;
    frames.forEach((rawFrame, frameIndex) => {
      const frame = objectOf(rawFrame);
      const timeMs = countOf(frame.timeMs);
      const frameType = stringOf(frame.type);
      const frameFile = stringOf(frame.file);
      if (
        timeMs === undefined ||
        frameType === undefined ||
        !(IMAGE_TYPES as readonly string[]).includes(frameType) ||
        frameFile === undefined ||
        !MEDIA_PATH.test(frameFile)
      ) {
        return;
      }
      const expectedFrame = `${refId}/${id}-t${timeMs}.${EXTENSION[frameType as keyof typeof EXTENSION]}`;
      if (frameFile !== expectedFrame) {
        addRuleIssue(
          ctx,
          ["media", index, "frames", frameIndex, "file"],
          `must be "${expectedFrame}" (<reference id>/<media id>-t<timeMs>.<extension of the type>).`,
        );
      }
    });
  });
  return byId;
}

function checkPins(
  reference: Loose,
  media: Map<string, MediaFacts> | undefined,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  listOf(reference.pins).forEach((raw, index) => {
    const pin = objectOf(raw);
    const id = stringOf(pin.id);
    if (id !== undefined && PIN_ID.test(id)) {
      if (seen.has(id)) {
        addRuleIssue(
          ctx,
          ["pins", index, "id"],
          `${JSON.stringify(id)} is used by more than one pin.`,
          "duplicate-id",
        );
      }
      seen.add(id);
    }

    const mediaId = stringOf(pin.mediaId);
    if (mediaId === undefined || !MEDIA_ID.test(mediaId)) return;
    if (media === undefined) return; // media is not a list: reported by its own rule
    const target = media.get(mediaId);
    if (target === undefined) {
      addRuleIssue(
        ctx,
        ["pins", index, "mediaId"],
        `${JSON.stringify(mediaId)} is not a media item of this reference.`,
        "broken-local-link",
      );
      return;
    }
    const { frameMs } = pin;
    if (frameMs !== null && countOf(frameMs) === undefined) return; // reported by its own rule
    if (frameMs === undefined) return;
    if (target.kind === "video") {
      if (frameMs === null || !target.frameTimes.has(frameMs as number)) {
        addRuleIssue(
          ctx,
          ["pins", index, "frameMs"],
          `must be the timeMs of a frame of video ${mediaId}${frameMs === null ? ", not null" : ""}.`,
          "broken-local-link",
        );
      }
    } else if (target.kind !== undefined && frameMs !== null) {
      addRuleIssue(
        ctx,
        ["pins", index, "frameMs"],
        `must be null: ${mediaId} is not a video.`,
        "broken-local-link",
      );
    }
  });
}

function checkInterpretations(reference: Loose, ctx: z.RefinementCtx): void {
  const pieces = new Set(["p0"]);
  for (const raw of listOf(reference.pins)) {
    const id = stringOf(objectOf(raw).id);
    if (id !== undefined) pieces.add(id);
  }
  if (!Array.isArray(reference.pins)) return;
  for (const key of Object.keys(objectOf(reference.interpretations))) {
    if (PIECE_ID.test(key) && !pieces.has(key)) {
      addRuleIssue(
        ctx,
        ["interpretations", key],
        `${JSON.stringify(key)} is not p0 or a pin of this reference.`,
        "broken-local-link",
      );
    }
  }
}

function checkCounters(reference: Loose, ctx: z.RefinementCtx): void {
  const lastIssued = objectOf(reference.lastIssued);
  const highest = (list: unknown, pattern: RegExp): number =>
    Math.max(
      0,
      ...listOf(list).flatMap((raw) => {
        const id = stringOf(objectOf(raw).id);
        return id !== undefined && pattern.test(id) ? [sequenceNumber(id)] : [];
      }),
    );
  // A counter that breaks its own bound (0 media, a negative number) is reported by that bound only.
  const media = countOf(lastIssued.media);
  const highestMedia = highest(reference.media, MEDIA_ID);
  if (media !== undefined && media >= 1 && media < highestMedia) {
    addRuleIssue(
      ctx,
      ["lastIssued", "media"],
      `must be at least ${highestMedia}, the highest media id in use.`,
    );
  }
  const pin = countOf(lastIssued.pin);
  const highestPin = highest(reference.pins, PIN_ID);
  if (pin !== undefined && pin < highestPin) {
    addRuleIssue(
      ctx,
      ["lastIssued", "pin"],
      `must be at least ${highestPin}, the highest pin id in use.`,
    );
  }
}

export type Reference = z.infer<typeof ReferenceSchema>;
