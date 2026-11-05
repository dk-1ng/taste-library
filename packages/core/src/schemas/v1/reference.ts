import { z } from "zod";
import {
  addRuleIssue,
  authored,
  DirectionId,
  HttpUrl,
  integer,
  isAfter,
  isRefId,
  LocalPieceId,
  MediaId,
  Note,
  PinId,
  RefId,
  Sha256,
  sequenceNumber,
  Slug,
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
  .superRefine((media, ctx) => {
    const isVideo = media.kind === "video";
    if (isVideo && !media.type.startsWith("video/")) {
      addRuleIssue(ctx, ["type"], 'must be a video type when kind is "video".');
    } else if (!isVideo && !media.type.startsWith("image/")) {
      addRuleIssue(ctx, ["type"], `must be an image type when kind is "${media.kind}".`);
    }
    if (isVideo && media.durationMs === null) {
      addRuleIssue(ctx, ["durationMs"], 'must not be null when kind is "video".');
    } else if (!isVideo && media.durationMs !== null) {
      addRuleIssue(ctx, ["durationMs"], 'must be null unless kind is "video".');
    }
    if (!isVideo && media.frames.length > 0) {
      addRuleIssue(ctx, ["frames"], 'must be empty unless kind is "video".');
    }
    const firstAt = new Map<number, number>();
    media.frames.forEach((frame, index) => {
      const first = firstAt.get(frame.timeMs);
      if (first !== undefined) {
        addRuleIssue(ctx, ["frames", index, "timeMs"], `must not repeat frames[${first}].timeMs.`);
      } else {
        firstAt.set(frame.timeMs, index);
      }
      if (isVideo && media.durationMs !== null && frame.timeMs > media.durationMs) {
        addRuleIssue(
          ctx,
          ["frames", index, "timeMs"],
          `must not be greater than durationMs (${media.durationMs}).`,
        );
      }
    });
  });

const Region = z
  .strictObject({
    x: z.number().min(0),
    y: z.number().min(0),
    w: z.number().gt(0),
    h: z.number().gt(0),
  })
  .superRefine((region, ctx) => {
    if (region.x + region.w > 1 + REGION_TOLERANCE) {
      addRuleIssue(ctx, ["w"], "must not reach beyond the right edge: x + w must be at most 1.");
    }
    if (region.y + region.h > 1 + REGION_TOLERANCE) {
      addRuleIssue(ctx, ["h"], "must not reach beyond the bottom edge: y + h must be at most 1.");
    }
  });

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
  .superRefine((reference, ctx) => {
    if (isAfter(reference.createdAt, reference.updatedAt)) {
      addRuleIssue(ctx, ["updatedAt"], "must not be earlier than createdAt.");
    }
    if (reference.source.via === "url-capture" && reference.source.url === null) {
      addRuleIssue(ctx, ["source", "url"], 'must not be null when via is "url-capture".');
    }
    checkMedia(reference, ctx);
    checkPins(reference, ctx);
    checkInterpretations(reference, ctx);
    checkCounters(reference, ctx);
  });

type ReferenceValue = z.output<typeof ReferenceSchema>;

function checkMedia(reference: ReferenceValue, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  reference.media.forEach((media, index) => {
    if (seen.has(media.id))
      addRuleIssue(
        ctx,
        ["media", index, "id"],
        `"${media.id}" is used by more than one media item.`,
        "duplicate-id",
      );
    seen.add(media.id);

    // The expected names are built from the ids, so a malformed id or path is reported once, by
    // its own rule, and not again as a name that does not match.
    if (!isRefId(reference.id) || !MEDIA_ID.test(media.id)) return;
    const expected = `${reference.id}/${media.id}.${EXTENSION[media.type]}`;
    if (MEDIA_PATH.test(media.file) && media.file !== expected) {
      addRuleIssue(
        ctx,
        ["media", index, "file"],
        `must be "${expected}" (<reference id>/<media id>.<extension of the type>).`,
      );
    }
    media.frames.forEach((frame, frameIndex) => {
      const expectedFrame = `${reference.id}/${media.id}-t${frame.timeMs}.${EXTENSION[frame.type]}`;
      if (
        Number.isInteger(frame.timeMs) &&
        frame.timeMs >= 0 &&
        MEDIA_PATH.test(frame.file) &&
        frame.file !== expectedFrame
      ) {
        addRuleIssue(
          ctx,
          ["media", index, "frames", frameIndex, "file"],
          `must be "${expectedFrame}" (<reference id>/<media id>-t<timeMs>.<extension of the type>).`,
        );
      }
    });
  });
}

function checkPins(reference: ReferenceValue, ctx: z.RefinementCtx): void {
  const mediaById = new Map<string, ReferenceValue["media"][number]>();
  for (const media of reference.media) if (!mediaById.has(media.id)) mediaById.set(media.id, media);

  const seen = new Set<string>();
  reference.pins.forEach((pin, index) => {
    if (seen.has(pin.id))
      addRuleIssue(
        ctx,
        ["pins", index, "id"],
        `"${pin.id}" is used by more than one pin.`,
        "duplicate-id",
      );
    seen.add(pin.id);

    const media = mediaById.get(pin.mediaId);
    if (media === undefined) {
      addRuleIssue(
        ctx,
        ["pins", index, "mediaId"],
        `"${pin.mediaId}" is not a media item of this reference.`,
        "broken-local-link",
      );
    } else if (media.kind === "video") {
      if (pin.frameMs === null || !media.frames.some((frame) => frame.timeMs === pin.frameMs)) {
        addRuleIssue(
          ctx,
          ["pins", index, "frameMs"],
          `must be the timeMs of a frame of video ${media.id}${pin.frameMs === null ? ", not null" : ""}.`,
          "broken-local-link",
        );
      }
    } else if (pin.frameMs !== null) {
      addRuleIssue(
        ctx,
        ["pins", index, "frameMs"],
        `must be null: ${media.id} is not a video.`,
        "broken-local-link",
      );
    }
  });
}

function checkInterpretations(reference: ReferenceValue, ctx: z.RefinementCtx): void {
  const pieces = new Set(["p0", ...reference.pins.map((pin) => pin.id)]);
  for (const key of Object.keys(reference.interpretations)) {
    if (!pieces.has(key)) {
      addRuleIssue(
        ctx,
        ["interpretations", key],
        `"${key}" is not p0 or a pin of this reference.`,
        "broken-local-link",
      );
    }
  }
}

function checkCounters(reference: ReferenceValue, ctx: z.RefinementCtx): void {
  const highestMedia = Math.max(0, ...reference.media.map((media) => sequenceNumber(media.id)));
  // A counter that breaks its own bound (0 media, a negative number) is reported by that bound only.
  if (reference.lastIssued.media >= 1 && reference.lastIssued.media < highestMedia) {
    addRuleIssue(
      ctx,
      ["lastIssued", "media"],
      `must be at least ${highestMedia}, the highest media id in use.`,
    );
  }
  const highestPin = Math.max(0, ...reference.pins.map((pin) => sequenceNumber(pin.id)));
  if (reference.lastIssued.pin >= 0 && reference.lastIssued.pin < highestPin) {
    addRuleIssue(
      ctx,
      ["lastIssued", "pin"],
      `must be at least ${highestPin}, the highest pin id in use.`,
    );
  }
}

export type Reference = z.infer<typeof ReferenceSchema>;
