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
  isMediaId,
  isPieceId,
  isPinId,
  isRefId,
  LocalPieceId,
  type Loose,
  listOf,
  MediaId,
  Note,
  objectOf,
  PinId,
  RefId,
  Sha256,
  Slug,
  sequenceNumber,
  stringOf,
  TagList,
  Timestamp,
  text,
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

type Frame = z.infer<typeof Frame>;

/**
 * A media item. `frames` is typed as a list of frames but read as it comes, and checked by kind in
 * the cross check below: only a video has frames, and an unknown kind must not hide the item's
 * other fields.
 */
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
    frames: z.custom<Frame[]>(),
  })
  .check(
    crossCheck((raw, ctx) => {
      const media = objectOf(raw);
      const kind = stringOf(media.kind);
      if (kind !== "image" && kind !== "page" && kind !== "video") {
        // Only the kind says what the frames must hold, but they must be a list in any case.
        checkFrames(media.frames, "any", ctx);
        return;
      }
      const isVideo = kind === "video";
      checkFrames(media.frames, isVideo ? "video" : "other", ctx);
      const type = stringOf(media.type);
      if (type !== undefined && Object.hasOwn(EXTENSION, type)) {
        if (isVideo && !type.startsWith("video/")) {
          addRuleIssue(ctx, ["type"], 'must be a video type when kind is "video".');
        } else if (!isVideo && !type.startsWith("image/")) {
          addRuleIssue(ctx, ["type"], `must be an image type when kind is "${kind}".`);
        }
      }
      const rawDuration = media.durationMs;
      const duration =
        countOf(rawDuration) !== undefined && (rawDuration as number) >= 1
          ? (rawDuration as number)
          : undefined;
      if (isVideo && rawDuration === null) {
        addRuleIssue(ctx, ["durationMs"], 'must not be null when kind is "video".');
      } else if (!isVideo && duration !== undefined) {
        addRuleIssue(ctx, ["durationMs"], 'must be null unless kind is "video".');
      }
      if (!isVideo) return;
      const frames = listOf(media.frames);
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
        if (duration !== undefined && timeMs > duration) {
          addRuleIssue(
            ctx,
            ["frames", index, "timeMs"],
            `must not be greater than durationMs (${duration}).`,
          );
        }
      });
    }),
  );

const NoFrames = z.array(z.unknown()).superRefine((frames, ctx) => {
  if (frames.length > 0) addRuleIssue(ctx, [], 'must be empty unless kind is "video".');
});
const AnyFrames = z.array(z.unknown());
const VideoFrames = z.array(Frame).max(1000);

/** Parses the frames by kind and reports what is wrong with them under `frames`. */
function checkFrames(frames: unknown, kind: "video" | "other" | "any", ctx: z.RefinementCtx): void {
  const schema = kind === "video" ? VideoFrames : kind === "other" ? NoFrames : AnyFrames;
  const result = schema.safeParse(frames, { reportInput: true });
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({ ...issue, path: ["frames", ...issue.path] } as never);
  }
}

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
 * a word, and the user's data is refused, never altered, so that key is refused first. The issue
 * is an `unrecognized_keys` one because zod's pipe goes on after that code and only that code, so
 * the rest of the record is still checked and reported with it.
 */
function recordOf<K extends z.core.$ZodRecordKey, V extends z.ZodType>(key: K, value: V) {
  const guard = z.unknown().superRefine((input, ctx) => {
    if (typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")) {
      ctx.addIssue({
        code: "unrecognized_keys",
        keys: ["__proto__"],
        path: [],
        input: input as Record<string, unknown>,
        params: { message: 'is not allowed; keys are "p0" or the id of a pin.' },
      } as never);
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
type MediaFacts = {
  kind: "image" | "page" | "video" | undefined;
  frameTimes: Set<number>;
  /** Every frame has a well-formed time, so a time that is not in the set is really missing. */
  framesComplete: boolean;
};

/** The media items by id, and whether every item has a well-formed id (else a missing id may just be malformed). */
type MediaIndex = { byId: Map<string, MediaFacts>; complete: boolean };

function checkMedia(refId: string, reference: Loose, ctx: z.RefinementCtx): MediaIndex {
  const byId = new Map<string, MediaFacts>();
  let complete = true;
  const idIsValid = isRefId(refId);
  listOf(reference.media).forEach((raw, index) => {
    const media = objectOf(raw);
    const id = stringOf(media.id);
    if (id === undefined || !isMediaId(id)) {
      complete = false;
      return;
    }
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
    const times = frames.map((frame) => countOf(objectOf(frame).timeMs));
    const kind = stringOf(media.kind);
    byId.set(id, {
      kind: kind === "image" || kind === "page" || kind === "video" ? kind : undefined,
      frameTimes: new Set(times.filter((t) => t !== undefined)),
      framesComplete: Array.isArray(media.frames) && times.every((t) => t !== undefined),
    });

    // The expected names are built from the ids, so a malformed id or path is reported once, by
    // its own rule, and not again as a name that does not match.
    if (!idIsValid) return;
    const type = stringOf(media.type);
    const file = stringOf(media.file);
    // A type that disagrees with the kind is reported by that rule; the file name that goes with
    // it is not asked to change as well.
    const kindKnown = media.kind === "image" || media.kind === "page" || media.kind === "video";
    const typeFitsKind =
      type !== undefined &&
      (!kindKnown ||
        (media.kind === "video" ? type.startsWith("video/") : type.startsWith("image/")));
    if (
      typeFitsKind &&
      type !== undefined &&
      Object.hasOwn(EXTENSION, type) &&
      file !== undefined &&
      MEDIA_PATH.test(file)
    ) {
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
  return { byId, complete };
}

function checkPins(reference: Loose, media: MediaIndex | undefined, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  listOf(reference.pins).forEach((raw, index) => {
    const pin = objectOf(raw);
    const id = stringOf(pin.id);
    if (id !== undefined && isPinId(id)) {
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
    if (mediaId === undefined || !isMediaId(mediaId)) return;
    if (media === undefined) return; // media is not a list: reported by its own rule
    const target = media.byId.get(mediaId);
    if (target === undefined) {
      if (!media.complete) return; // the item may be there with a malformed id
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
      if (frameMs !== null && !target.framesComplete && !target.frameTimes.has(frameMs as number)) {
        return; // the frame may be there with a malformed time
      }
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
  if (!Array.isArray(reference.pins)) return;
  const pieces = new Set(["p0"]);
  for (const raw of reference.pins) {
    const id = stringOf(objectOf(raw).id);
    // A pin whose id is malformed may be the one the key means: reported by its own rule.
    if (id === undefined || !isPinId(id)) return;
    pieces.add(id);
  }
  for (const key of Object.keys(objectOf(reference.interpretations))) {
    if (isPieceId(key) && !pieces.has(key)) {
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
  const highest = (list: unknown, isId: (id: string) => boolean): number =>
    Math.max(
      0,
      ...listOf(list).flatMap((raw) => {
        const id = stringOf(objectOf(raw).id);
        return id !== undefined && isId(id) ? [sequenceNumber(id)] : [];
      }),
    );
  // A counter that breaks its own bound (0 media, a negative number) is reported by that bound only.
  const media = countOf(lastIssued.media);
  const highestMedia = highest(reference.media, isMediaId);
  if (media !== undefined && media >= 1 && media < highestMedia) {
    addRuleIssue(
      ctx,
      ["lastIssued", "media"],
      `must be at least ${highestMedia}, the highest media id in use.`,
    );
  }
  const pin = countOf(lastIssued.pin);
  const highestPin = highest(reference.pins, isPinId);
  if (pin !== undefined && pin < highestPin) {
    addRuleIssue(
      ctx,
      ["lastIssued", "pin"],
      `must be at least ${highestPin}, the highest pin id in use.`,
    );
  }
}

export type Reference = z.infer<typeof ReferenceSchema>;
