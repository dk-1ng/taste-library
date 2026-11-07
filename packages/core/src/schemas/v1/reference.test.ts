import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issuesFromZod } from "../../validation/zod-issues.js";
import { type Reference, ReferenceSchema } from "./reference.js";

// biome-ignore lint/suspicious/noExplicitAny: the fixtures are plain JSON that tests mutate by path.
type Loose = any;

const REF = "ref-20261104-k3x9ab";
const NOTE = "Calm and dense at the same time.";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const MEDIA_SHA = sha("synthetic media bytes");

/** The example of format-spec §7.8, with a real checksum for the media and for the note. */
function example(): Loose {
  return {
    formatVersion: 1,
    id: REF,
    createdAt: "2026-11-04T12:00:00.000Z",
    updatedAt: "2026-11-04T12:05:00.000Z",
    source: { via: "url-capture", url: "https://example.com/" },
    result: null,
    media: [
      {
        id: "m1",
        kind: "page",
        file: `${REF}/m1.webp`,
        type: "image/webp",
        bytes: 48213,
        sha256: MEDIA_SHA,
        width: 1440,
        height: 5200,
        durationMs: null,
        frames: [],
      },
    ],
    note: NOTE,
    pins: [
      {
        id: "p1",
        mediaId: "m1",
        frameMs: null,
        region: { x: 0.08, y: 0.12, w: 0.4, h: 0.3 },
        polarity: "negative",
        note: "This hero is too loud.",
        createdAt: "2026-11-04T12:01:00.000Z",
      },
    ],
    interpretations: {
      p0: {
        origin: "agent",
        proposedBy: "claude-code",
        proposedAt: "2026-11-04T12:05:00.000Z",
        inputSha256: sha(NOTE),
        proposal: {
          summary: "High information density with quiet contrast.",
          vocabulary: ["quiet density"],
          keywords: ["calm", "dense"],
          screenTypes: ["landing page"],
          components: [],
          aspects: ["layout"],
        },
        status: "to-review",
        correction: null,
        reviewedAt: null,
      },
    },
    lastIssued: { media: 1, pin: 1 },
  };
}

function video(): Loose {
  return {
    id: "m2",
    kind: "video",
    file: `${REF}/m2.mp4`,
    type: "video/mp4",
    bytes: 1000,
    sha256: MEDIA_SHA,
    width: 640,
    height: 360,
    durationMs: 4000,
    frames: [
      {
        timeMs: 0,
        file: `${REF}/m2-t0.png`,
        type: "image/png",
        bytes: 10,
        sha256: MEDIA_SHA,
        width: 640,
        height: 360,
      },
      {
        timeMs: 1500,
        file: `${REF}/m2-t1500.webp`,
        type: "image/webp",
        bytes: 10,
        sha256: MEDIA_SHA,
        width: 640,
        height: 360,
      },
    ],
  };
}

type Found = { code: string; pointer: string | null; message: string };
function validate(value: unknown): Found[] {
  const result = ReferenceSchema.safeParse(value, { reportInput: true });
  return result.success ? [] : issuesFromZod(result.error, `references/${REF}.json`);
}
/** Applies a change to a copy of the example and returns the issues. */
function broken(change: (r: Loose) => void): Found[] {
  const r = example();
  change(r);
  return validate(r);
}
function expectOne(found: Found[], code: string, pointer: string, message?: string) {
  expect(found.map((f) => `${f.code} ${f.pointer}: ${f.message}`)).toHaveLength(1);
  expect(found[0]).toMatchObject({ code, pointer });
  if (message) expect(found[0]?.message).toBe(message);
}

describe("reference: the example and valid variants", () => {
  it("accepts the example of format-spec §7.8", () => {
    expect(validate(example())).toEqual([]);
  });

  it("accepts a video with frames, a pin on a frame, non-ASCII notes and the file-picker source", () => {
    const r = example();
    r.source = { via: "file-picker", url: null };
    r.media.push(video());
    r.note = "Ação e vírgulas, 日本語 😀";
    r.pins.push({
      ...r.pins[0],
      id: "p2",
      mediaId: "m2",
      frameMs: 1500,
      note: "Rótulo do botão — não é isso",
      polarity: "positive",
    });
    r.lastIssued = { media: 2, pin: 2 };
    expect(validate(r)).toEqual([]);
  });

  it("accepts every source", () => {
    for (const via of ["paste", "drop", "file-picker"]) {
      expect(broken((r) => (r.source = { via, url: null }))).toEqual([]);
    }
    expect(broken((r) => (r.source = { via: "paste", url: "https://example.com/a" }))).toEqual([]);
  });

  it("accepts a result, no pins and counters above the numbers in use", () => {
    expect(broken((r) => (r.result = { project: "landing", direction: "d1" }))).toEqual([]);
    expect(broken((r) => (r.result = { project: "landing", direction: null }))).toEqual([]);
    expect(
      broken((r) => {
        r.pins = [];
        r.interpretations = {};
        r.lastIssued = { media: 7, pin: 0 };
      }),
    ).toEqual([]);
    expect(broken((r) => (r.lastIssued = { media: 9, pin: 9 }))).toEqual([]);
  });

  it("accepts regions on the edges and within the tolerance", () => {
    expect(broken((r) => (r.pins[0].region = { x: 0, y: 0, w: 1, h: 1 }))).toEqual([]);
    expect(broken((r) => (r.pins[0].region = { x: 0.5, y: 0.5, w: 0.5 + 5e-10, h: 0.5 }))).toEqual(
      [],
    );
  });

  it("accepts the limits: 50 media items, 500 pins", () => {
    const r = example();
    r.media = Array.from({ length: 50 }, (_, i) => ({
      ...r.media[0],
      id: `m${i + 1}`,
      file: `${REF}/m${i + 1}.webp`,
    }));
    r.pins = Array.from({ length: 500 }, (_, i) => ({ ...r.pins[0], id: `p${i + 1}` }));
    r.lastIssued = { media: 50, pin: 500 };
    expect(validate(r)).toEqual([]);
  });
});

describe("reference: strictness", () => {
  it("refuses an unknown field at the top and in nested objects", () => {
    expectOne(
      broken((r) => (r.extra = 1)),
      "schema-violation",
      "/extra",
      "extra: is not a field of this file.",
    );
    expectOne(
      broken((r) => (r.media[0].extra = 1)),
      "schema-violation",
      "/media/0/extra",
    );
    expectOne(
      broken((r) => (r.pins[0].region.extra = 1)),
      "schema-violation",
      "/pins/0/region/extra",
    );
    expectOne(
      broken((r) => (r.lastIssued.extra = 1)),
      "schema-violation",
      "/lastIssued/extra",
    );
    expectOne(
      broken((r) => (r.source.extra = 1)),
      "schema-violation",
      "/source/extra",
    );
  });

  it("refuses a missing field, including one whose value would be null or empty", () => {
    expectOne(
      broken((r) => delete r.result),
      "schema-violation",
      "/result",
      "result: is required.",
    );
    expectOne(
      broken((r) => delete r.source.url),
      "schema-violation",
      "/source/url",
    );
    expectOne(
      broken((r) => delete r.media[0].durationMs),
      "schema-violation",
      "/media/0/durationMs",
    );
    expectOne(
      broken((r) => delete r.media[0].frames),
      "schema-violation",
      "/media/0/frames",
    );
    expectOne(
      broken((r) => delete r.pins[0].frameMs),
      "schema-violation",
      "/pins/0/frameMs",
    );
    expectOne(
      broken((r) => delete r.pins),
      "schema-violation",
      "/pins",
    );
    expectOne(
      broken((r) => delete r.interpretations),
      "schema-violation",
      "/interpretations",
    );
    expectOne(
      broken((r) => delete r.interpretations.p0.correction),
      "schema-violation",
      "/interpretations/p0/correction",
    );
    expectOne(
      broken((r) => delete r.interpretations.p0.proposal.components),
      "schema-violation",
      "/interpretations/p0/proposal/components",
    );
    expectOne(
      broken((r) => delete r.lastIssued),
      "schema-violation",
      "/lastIssued",
    );
  });

  it("refuses a wrong type", () => {
    expectOne(
      broken((r) => (r.note = 5)),
      "schema-violation",
      "/note",
      "note: must be a string.",
    );
    expectOne(
      broken((r) => (r.media = {})),
      "schema-violation",
      "/media",
      "media: must be an array.",
    );
    expectOne(
      broken((r) => (r.media[0].bytes = "12")),
      "schema-violation",
      "/media/0/bytes",
    );
    expectOne(
      broken((r) => (r.media[0].bytes = 1.5)),
      "schema-violation",
      "/media/0/bytes",
      "media[0].bytes: must be an integer.",
    );
  });
});

describe("reference: fields", () => {
  it("formatVersion, id and timestamps", () => {
    expectOne(
      broken((r) => (r.formatVersion = 2)),
      "schema-violation",
      "/formatVersion",
      "formatVersion: must be 1.",
    );
    expectOne(
      broken((r) => (r.id = "ref-20261331-k3x9ab")),
      "schema-violation",
      "/id",
    );
    expectOne(
      broken((r) => (r.createdAt = "yesterday")),
      "schema-violation",
      "/createdAt",
    );
    expectOne(
      broken((r) => (r.updatedAt = "2026-11-04T11:59:59.999Z")),
      "schema-violation",
      "/updatedAt",
      "updatedAt: must not be earlier than createdAt.",
    );
  });

  it("source", () => {
    expectOne(
      broken((r) => (r.source.via = "scan")),
      "schema-violation",
      "/source/via",
    );
    expectOne(
      broken((r) => (r.source.url = null)),
      "schema-violation",
      "/source/url",
    );
    expectOne(
      broken((r) => (r.source.url = "https://example.com")),
      "schema-violation",
      "/source/url",
    );
    expectOne(
      broken((r) => (r.source.url = "ftp://example.com/")),
      "schema-violation",
      "/source/url",
    );
    expectOne(
      broken((r) => (r.source = { via: "paste", url: "https://u:p@example.com/" })),
      "schema-violation",
      "/source/url",
    );
  });

  it("result", () => {
    expectOne(
      broken((r) => (r.result = { project: "CON", direction: null })),
      "schema-violation",
      "/result/project",
    );
    expectOne(
      broken((r) => (r.result = { project: "con", direction: null })),
      "schema-violation",
      "/result/project",
    );
    expectOne(
      broken((r) => (r.result = { project: "p", direction: "d0" })),
      "schema-violation",
      "/result/direction",
    );
  });

  it("note", () => {
    expectOne(
      broken((r) => (r.note = "a".repeat(100001))),
      "schema-violation",
      "/note",
    );
    expectOne(
      broken((r) => (r.note = "a\rb")),
      "schema-violation",
      "/note",
    );
    expect(broken((r) => (r.note = ""))).toEqual([]);
    expect(broken((r) => (r.note = "  keeps\tits\n whitespace  "))).toEqual([]);
  });
});

describe("reference: media", () => {
  it("has 1 to 50 items", () => {
    expectOne(
      broken((r) => {
        r.media = [];
        r.pins = [];
        r.interpretations = {};
      }),
      "schema-violation",
      "/media",
      "media: must have at least 1 item.",
    );
    const r = example();
    r.media = Array.from({ length: 51 }, (_, i) => ({
      ...r.media[0],
      id: `m${i + 1}`,
      file: `${REF}/m${i + 1}.webp`,
    }));
    r.lastIssued.media = 51;
    expectOne(validate(r), "schema-violation", "/media", "media: must have at most 50 items.");
  });

  it("refuses the same media id twice with duplicate-id", () => {
    const found = broken((r) => r.media.push({ ...r.media[0] }));
    expectOne(found, "duplicate-id", "/media/1/id");
  });

  it("kind and type must agree", () => {
    expectOne(
      broken((r) => {
        r.media[0].type = "video/mp4";
        r.media[0].file = `${REF}/m1.mp4`;
      }),
      "schema-violation",
      "/media/0/type",
    );
    expect(broken((r) => (r.media[0].kind = "image"))).toEqual([]);
  });

  it("refuses kind video with an image type", () => {
    const r = example();
    r.media = [{ ...video(), id: "m1", file: `${REF}/m1.webp`, type: "image/webp", frames: [] }];
    r.pins = [];
    r.interpretations = {};
    r.lastIssued = { media: 1, pin: 0 };
    expectOne(validate(r), "schema-violation", "/media/0/type");
  });

  it("file must be <ref-id>/<media-id>.<extension of the type>", () => {
    expectOne(
      broken((r) => (r.media[0].file = `${REF}/m1.png`)),
      "schema-violation",
      "/media/0/file",
    );
    expectOne(
      broken((r) => (r.media[0].file = `${REF}/m2.webp`)),
      "schema-violation",
      "/media/0/file",
    );
    expectOne(
      broken((r) => (r.media[0].file = "ref-20261104-aaaaaa/m1.webp")),
      "schema-violation",
      "/media/0/file",
    );
    expectOne(
      broken((r) => (r.media[0].file = "../m1.webp")),
      "schema-violation",
      "/media/0/file",
    );
    expectOne(
      broken((r) => (r.media[0].file = `${REF}/m1.jpeg`)),
      "schema-violation",
      "/media/0/file",
    );
    for (const [type, ext] of [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/avif", "avif"],
    ] as const) {
      expect(
        broken((r) => {
          r.media[0].type = type;
          r.media[0].file = `${REF}/m1.${ext}`;
        }),
      ).toEqual([]);
    }
  });

  it("bytes, sha256 and dimensions", () => {
    expectOne(
      broken((r) => (r.media[0].bytes = 0)),
      "schema-violation",
      "/media/0/bytes",
      "media[0].bytes: must be at least 1.",
    );
    expectOne(
      broken((r) => (r.media[0].sha256 = "x")),
      "schema-violation",
      "/media/0/sha256",
    );
    expectOne(
      broken((r) => (r.media[0].width = 0)),
      "schema-violation",
      "/media/0/width",
    );
    expectOne(
      broken((r) => (r.media[0].height = 1000001)),
      "schema-violation",
      "/media/0/height",
    );
    expectOne(
      broken((r) => (r.media[0].bytes = 2 ** 53)),
      "schema-violation",
      "/media/0/bytes",
    );
    expect(
      broken((r) => {
        r.media[0].width = 1000000;
        r.media[0].bytes = 2 ** 53 - 1;
      }),
    ).toEqual([]);
  });

  it("durationMs only for videos", () => {
    expectOne(
      broken((r) => (r.media[0].durationMs = 1000)),
      "schema-violation",
      "/media/0/durationMs",
    );
    const r = example();
    r.media = [{ ...video(), id: "m1", file: `${REF}/m1.mp4`, durationMs: null, frames: [] }];
    r.pins = [];
    r.interpretations = {};
    expectOne(validate(r), "schema-violation", "/media/0/durationMs");
    r.media[0].durationMs = 0;
    expectOne(validate(r), "schema-violation", "/media/0/durationMs");
  });

  it("frames only for videos", () => {
    expectOne(
      broken(
        (r) =>
          (r.media[0].frames = video().frames.map((f: Loose) => ({
            ...f,
            file: f.file.replace("m2", "m1"),
          }))),
      ),
      "schema-violation",
      "/media/0/frames",
    );
  });
});

describe("reference: frames", () => {
  function withVideo(change: (m: Loose) => void, pins = false): Found[] {
    const r = example();
    const m = video();
    change(m);
    r.media.push(m);
    r.lastIssued.media = 2;
    if (!pins) {
      r.pins = [];
      r.interpretations = {};
      r.lastIssued.pin = 1;
    }
    return validate(r);
  }

  it("a video with frames is valid, and a video with none too", () => {
    expect(withVideo(() => {})).toEqual([]);
    expect(withVideo((m) => (m.frames = []))).toEqual([]);
  });

  it("timeMs is between 0 and durationMs", () => {
    expectOne(
      withVideo((m) => {
        m.frames[1].timeMs = 4001;
        m.frames[1].file = `${REF}/m2-t4001.webp`;
      }),
      "schema-violation",
      "/media/1/frames/1/timeMs",
    );
    expectOne(
      withVideo((m) => {
        m.frames[0].timeMs = -1;
      }),
      "schema-violation",
      "/media/1/frames/0/timeMs",
    );
    expect(
      withVideo((m) => {
        m.frames[1].timeMs = 4000;
        m.frames[1].file = `${REF}/m2-t4000.webp`;
      }),
    ).toEqual([]);
  });

  it("timeMs is unique, reported as schema-violation", () => {
    const found = withVideo((m) => m.frames.push({ ...m.frames[1] }));
    expectOne(found, "schema-violation", "/media/1/frames/2/timeMs");
  });

  it("file is <ref-id>/<media-id>-t<timeMs>.<extension of the type>", () => {
    expectOne(
      withVideo((m) => (m.frames[0].file = `${REF}/m2-t1.png`)),
      "schema-violation",
      "/media/1/frames/0/file",
    );
    expectOne(
      withVideo((m) => (m.frames[0].file = `${REF}/m2-t0.webp`)),
      "schema-violation",
      "/media/1/frames/0/file",
    );
    expectOne(
      withVideo((m) => (m.frames[0].file = `${REF}/m1-t0.png`)),
      "schema-violation",
      "/media/1/frames/0/file",
    );
    expectOne(
      withVideo((m) => (m.frames[0].file = `${REF}/m2.png`)),
      "schema-violation",
      "/media/1/frames/0/file",
    );
  });

  it("a frame is an image, with positive size and a checksum", () => {
    expectOne(
      withVideo((m) => (m.frames[0].type = "video/mp4")),
      "schema-violation",
      "/media/1/frames/0/type",
    );
    expectOne(
      withVideo((m) => (m.frames[0].bytes = 0)),
      "schema-violation",
      "/media/1/frames/0/bytes",
    );
    expectOne(
      withVideo((m) => (m.frames[0].sha256 = "z")),
      "schema-violation",
      "/media/1/frames/0/sha256",
    );
    expectOne(
      withVideo((m) => (m.frames[0].width = 0)),
      "schema-violation",
      "/media/1/frames/0/width",
    );
  });

  it("has at most 1000 frames", () => {
    const found = withVideo((m) => {
      m.durationMs = 5000;
      m.frames = Array.from({ length: 1001 }, (_, i) => ({
        ...m.frames[0],
        timeMs: i,
        file: `${REF}/m2-t${i}.png`,
      }));
    });
    expectOne(
      found,
      "schema-violation",
      "/media/1/frames",
      "media[1].frames: must have at most 1000 items.",
    );
    expect(
      withVideo((m) => {
        m.durationMs = 5000;
        m.frames = Array.from({ length: 1000 }, (_, i) => ({
          ...m.frames[0],
          timeMs: i,
          file: `${REF}/m2-t${i}.png`,
        }));
      }),
    ).toEqual([]);
  });
});

describe("reference: pins", () => {
  it("has at most 500 pins", () => {
    const r = example();
    r.pins = Array.from({ length: 501 }, (_, i) => ({ ...r.pins[0], id: `p${i + 1}` }));
    r.lastIssued.pin = 501;
    expectOne(validate(r), "schema-violation", "/pins", "pins: must have at most 500 items.");
  });

  it("refuses the same pin id twice with duplicate-id", () => {
    expectOne(
      broken((r) => r.pins.push({ ...r.pins[0] })),
      "duplicate-id",
      "/pins/1/id",
    );
  });

  it("mediaId must name a media item of the reference", () => {
    expectOne(
      broken((r) => (r.pins[0].mediaId = "m2")),
      "broken-local-link",
      "/pins/0/mediaId",
    );
  });

  it("frameMs is null for an image and a frame time for a video", () => {
    expectOne(
      broken((r) => (r.pins[0].frameMs = 0)),
      "broken-local-link",
      "/pins/0/frameMs",
    );
    const onVideo = (frameMs: number | null) => {
      const r = example();
      r.media.push(video());
      r.lastIssued.media = 2;
      r.pins[0] = { ...r.pins[0], mediaId: "m2", frameMs };
      return validate(r);
    };
    expect(onVideo(1500)).toEqual([]);
    expectOne(onVideo(1000), "broken-local-link", "/pins/0/frameMs");
    expectOne(onVideo(null), "broken-local-link", "/pins/0/frameMs");
  });

  it("region is inside the media: 0 ≤ x, 0 ≤ y, 0 < w, 0 < h, x + w ≤ 1, y + h ≤ 1", () => {
    expectOne(
      broken((r) => (r.pins[0].region.x = -0.1)),
      "schema-violation",
      "/pins/0/region/x",
      "pins[0].region.x: must be at least 0.",
    );
    expectOne(
      broken((r) => (r.pins[0].region.y = -0.1)),
      "schema-violation",
      "/pins/0/region/y",
    );
    expectOne(
      broken((r) => (r.pins[0].region.w = 0)),
      "schema-violation",
      "/pins/0/region/w",
      "pins[0].region.w: must be greater than 0.",
    );
    expectOne(
      broken((r) => (r.pins[0].region.h = 0)),
      "schema-violation",
      "/pins/0/region/h",
    );
    expectOne(
      broken((r) => (r.pins[0].region = { x: 0.7, y: 0, w: 0.4, h: 0.1 })),
      "schema-violation",
      "/pins/0/region/w",
    );
    expectOne(
      broken((r) => (r.pins[0].region = { x: 0, y: 0.7, w: 0.1, h: 0.4 })),
      "schema-violation",
      "/pins/0/region/h",
    );
    expectOne(
      broken((r) => (r.pins[0].region = { x: 0.5, y: 0.5, w: 0.5 + 2e-9, h: 0.5 })),
      "schema-violation",
      "/pins/0/region/w",
    );
    expectOne(
      broken((r) => (r.pins[0].region.w = Number.NaN)),
      "schema-violation",
      "/pins/0/region/w",
    );
  });

  it("polarity, note and createdAt", () => {
    expectOne(
      broken((r) => (r.pins[0].polarity = "neutral")),
      "schema-violation",
      "/pins/0/polarity",
    );
    expectOne(
      broken((r) => (r.pins[0].note = 3)),
      "schema-violation",
      "/pins/0/note",
    );
    expectOne(
      broken((r) => (r.pins[0].createdAt = "x")),
      "schema-violation",
      "/pins/0/createdAt",
    );
    expect(broken((r) => (r.pins[0].note = ""))).toEqual([]);
  });

  it("reports every broken rule, also next to a type error", () => {
    const found = broken((r) => {
      r.pins[0].mediaId = "m9";
      r.pins[0].region.w = 0;
      r.pins[0].polarity = "x";
    });
    expect(found.map((f) => f.pointer).sort()).toEqual([
      "/pins/0/mediaId",
      "/pins/0/polarity",
      "/pins/0/region/w",
    ]);
  });

  it("reports a malformed value once, by its own rule", () => {
    expectOne(
      broken((r) => (r.pins[0].mediaId = "x1")),
      "schema-violation",
      "/pins/0/mediaId",
    );
    expectOne(
      broken((r) => (r.pins[0].frameMs = -1)),
      "schema-violation",
      "/pins/0/frameMs",
    );
    expectOne(
      broken((r) => r.pins.push({ ...r.pins[0], id: "x" })),
      "schema-violation",
      "/pins/1/id",
    );
    expectOne(
      broken((r) => {
        r.media.push({ ...r.media[0], id: "x" });
      }),
      "schema-violation",
      "/media/1/id",
    );
  });

  it("does not put control characters from the data into a message", () => {
    const found = broken((r) => (r.pins[0].mediaId = "\u001b]0;x\u0007"));
    expect(found.every((f) => !f.message.includes("\u001b"))).toBe(true);
    const link = broken((r) => (r.interpretations.p9 = structuredClone(r.interpretations.p0)));
    expect(link[0]?.message).toContain('"p9"');
  });
});

describe("reference: interpretations", () => {
  it("keys are p0 or a pin of the reference", () => {
    const p0 = example().interpretations.p0;
    expect(broken((r) => (r.interpretations.p1 = structuredClone(p0)))).toEqual([]);
    expectOne(
      broken((r) => (r.interpretations.p2 = structuredClone(p0))),
      "broken-local-link",
      "/interpretations/p2",
    );
    expectOne(
      broken((r) => (r.interpretations.x = structuredClone(p0))),
      "schema-violation",
      "/interpretations/x",
    );
  });

  it("refuses __proto__ as a key instead of dropping it", () => {
    const r = example();
    Object.defineProperty(r.interpretations, "__proto__", {
      value: structuredClone(r.interpretations.p0),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const found = validate(r);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: "schema-violation",
      pointer: "/interpretations/__proto__",
    });
  });

  it("inputSha256 is not null in a piece interpretation", () => {
    expectOne(
      broken((r) => (r.interpretations.p0.inputSha256 = null)),
      "schema-violation",
      "/interpretations/p0/inputSha256",
    );
  });

  it("applies the rules of Authored, with pointers into the map", () => {
    expectOne(
      broken((r) => (r.interpretations.p0.status = "accepted")),
      "schema-violation",
      "/interpretations/p0/reviewedAt",
    );
    expectOne(
      broken(
        (r) =>
          (r.interpretations.p0.correction = {
            summary: "x",
            vocabulary: [],
            keywords: [],
            screenTypes: [],
            components: [],
            aspects: [],
          }),
      ),
      "schema-violation",
      "/interpretations/p0/correction",
    );
    // Changing the origin makes the value the other form: the issues are about that form's fields.
    const flipped = broken((r) => (r.interpretations.p0.origin = "user"));
    expect(flipped.length).toBeGreaterThan(0);
    expect(
      flipped.every(
        (f) => f.code === "schema-violation" && f.pointer?.startsWith("/interpretations/p0/"),
      ),
    ).toBe(true);
  });

  it("applies the rules of the interpretation itself", () => {
    expectOne(
      broken((r) => (r.interpretations.p0.proposal.summary = "")),
      "schema-violation",
      "/interpretations/p0/proposal/summary",
    );
    expectOne(
      broken((r) => (r.interpretations.p0.proposal.summary = "x".repeat(2001))),
      "schema-violation",
      "/interpretations/p0/proposal/summary",
    );
    expectOne(
      broken((r) => (r.interpretations.p0.proposal.keywords = ["a", "A"])),
      "schema-violation",
      "/interpretations/p0/proposal/keywords/1",
    );
    expectOne(
      broken((r) => (r.interpretations.p0.proposal.guardrails = [])),
      "schema-violation",
      "/interpretations/p0/proposal/guardrails",
    );
    expectOne(
      broken((r) => (r.interpretations.p0.proposal.aspects = [" x"])),
      "schema-violation",
      "/interpretations/p0/proposal/aspects/0",
    );
  });

  it("a user interpretation may exist (origin user)", () => {
    expect(
      broken(
        (r) =>
          (r.interpretations.p0 = {
            origin: "user",
            content: {
              summary: "Mine",
              vocabulary: [],
              keywords: [],
              screenTypes: [],
              components: [],
              aspects: [],
            },
            writtenAt: "2026-11-04T12:06:00.000Z",
          }),
      ),
    ).toEqual([]);
  });
});

describe("reference: lastIssued", () => {
  it("is at least the highest number in use", () => {
    expectOne(
      broken((r) => (r.lastIssued.pin = 0)),
      "schema-violation",
      "/lastIssued/pin",
    );
    expectOne(
      broken((r) => (r.lastIssued.media = 0)),
      "schema-violation",
      "/lastIssued/media",
    );
    const r = example();
    r.media.push({ ...r.media[0], id: "m3", file: `${REF}/m3.webp` });
    expectOne(
      validate(r),
      "schema-violation",
      "/lastIssued/media",
      "lastIssued.media: must be at least 3, the highest media id in use.",
    );
    r.lastIssued.media = 3;
    expect(validate(r)).toEqual([]);
  });

  it("media is at least 1, pin may be 0, both are integers", () => {
    expect(
      broken((r) => {
        r.pins = [];
        r.interpretations = {};
        r.lastIssued.pin = 0;
      }),
    ).toEqual([]);
    expectOne(
      broken((r) => (r.lastIssued.pin = -1)),
      "schema-violation",
      "/lastIssued/pin",
    );
    expectOne(
      broken((r) => (r.lastIssued.pin = 1.5)),
      "schema-violation",
      "/lastIssued/pin",
    );
  });
});

describe("reference: order is not an error", () => {
  it("accepts media, pins, frames and interpretation keys out of order", () => {
    const r = example();
    const m2 = video();
    m2.frames.reverse();
    r.media = [m2, ...r.media];
    r.pins = [
      { ...r.pins[0], id: "p10" },
      { ...r.pins[0], id: "p2" },
      { ...r.pins[0], id: "p1" },
    ];
    const p0 = r.interpretations.p0;
    r.interpretations = { p10: structuredClone(p0), p2: structuredClone(p0), p0 };
    r.lastIssued = { media: 2, pin: 10 };
    expect(validate(r)).toEqual([]);
  });
});

describe("reference: frames of an image", () => {
  it("are reported once, as a whole", () => {
    const found = broken((r) => (r.media[0].frames = [...video().frames, ...video().frames]));
    expectOne(found, "schema-violation", "/media/0/frames");
  });
});

describe("reference: rules across fields next to type errors", () => {
  it("still reports duplicate ids, links, counters and dates when another field has the wrong type", () => {
    const found = broken((r) => {
      r.note = 5;
      r.media.push({ ...r.media[0] });
      r.updatedAt = "2026-11-04T11:00:00.000Z";
      r.lastIssued.pin = 0;
    });
    expect(found.map((f) => `${f.code} ${f.pointer}`).sort()).toEqual([
      "duplicate-id /media/1/id",
      "schema-violation /lastIssued/pin",
      "schema-violation /note",
      "schema-violation /updatedAt",
    ]);
  });

  it("does not fail on raw input of the wrong shape", () => {
    for (const patch of [
      { media: "x" },
      { pins: null },
      { pins: [1, null, "a"] },
      { media: [null, 3] },
      { interpretations: [] },
      { interpretations: null },
      { lastIssued: 5 },
      { source: [] },
      { media: [{ id: "m1", kind: "video", frames: "x", type: 3 }] },
    ]) {
      const r = { ...example(), ...patch };
      expect(() => validate(r)).not.toThrow();
      expect(validate(r).length).toBeGreaterThan(0);
    }
  });

  it("applies to the kind and type, the region, the review fields and tags", () => {
    const media = broken((r) => {
      r.media[0].type = "video/mp4";
      r.media[0].bytes = "x";
      r.media[0].file = `${REF}/m1.mp4`;
    });
    expect(media.map((f) => f.pointer).sort()).toEqual(["/media/0/bytes", "/media/0/type"]);
    const region = broken((r) => {
      r.pins[0].region = { x: 0.9, y: 0, w: 0.5, h: "x" };
    });
    expect(region.map((f) => f.pointer).sort()).toEqual(["/pins/0/region/h", "/pins/0/region/w"]);
    const tags = broken((r) => {
      r.interpretations.p0.proposal.keywords = ["a", "A", 5];
    });
    expect(tags.map((f) => f.pointer).sort()).toEqual([
      "/interpretations/p0/proposal/keywords/1",
      "/interpretations/p0/proposal/keywords/2",
    ]);
    const review = broken((r) => {
      r.interpretations.p0.status = "accepted";
      r.interpretations.p0.proposedBy = 5;
    });
    expect(review.map((f) => f.pointer).sort()).toEqual([
      "/interpretations/p0/proposedBy",
      "/interpretations/p0/reviewedAt",
    ]);
  });
});

describe("reference: a malformed value is reported once", () => {
  it("a non-integer number does not hide the rules across fields", () => {
    const found = broken((r) => {
      r.media.push({ ...r.media[0] });
      r.media[0].width = 1.5;
      r.pins[0].mediaId = "m9";
      r.lastIssued.pin = 0.5;
    });
    expect(found.map((f) => `${f.code} ${f.pointer}`).sort()).toEqual([
      "broken-local-link /pins/0/mediaId",
      "duplicate-id /media/1/id",
      "schema-violation /lastIssued/pin",
      "schema-violation /media/0/width",
    ]);
  });

  it("a type that is only an inherited property name is just an invalid option", () => {
    for (const type of ["toString", "constructor", "__proto__"]) {
      const found = broken((r) => (r.media[0].type = type));
      expect(found.map((f) => f.pointer)).toEqual(["/media/0/type"]);
    }
  });

  it("a malformed durationMs does not cascade to the frames or the kind rule", () => {
    const withVideo = (duration: number) => {
      const r = example();
      r.media.push({ ...video(), durationMs: duration });
      r.lastIssued.media = 2;
      return validate(r).map((f) => f.pointer);
    };
    expect(withVideo(-5)).toEqual(["/media/1/durationMs"]);
    expect(withVideo(0)).toEqual(["/media/1/durationMs"]);
    expect(broken((r) => (r.media[0].durationMs = -5)).map((f) => f.pointer)).toEqual([
      "/media/0/durationMs",
    ]);
  });

  it("a malformed kind does not make pins fail as if the media were an image", () => {
    const r = example();
    r.media.push({ ...video(), kind: "Video" });
    r.lastIssued.media = 2;
    r.pins.push({ ...r.pins[0], id: "p2", mediaId: "m2", frameMs: 0 });
    r.lastIssued.pin = 2;
    expect(validate(r).map((f) => f.pointer)).toEqual(["/media/1/kind"]);
  });

  it("a malformed id does not make the links to it fail", () => {
    const r1 = example();
    r1.media.push({ ...video(), id: "M2" });
    r1.lastIssued.media = 2;
    r1.pins.push({ ...r1.pins[0], id: "p2", mediaId: "m2", frameMs: 0 });
    r1.lastIssued.pin = 2;
    expect(validate(r1).map((f) => f.pointer)).toEqual(["/media/1/id"]);

    const r2 = example();
    const v = video();
    v.frames[1].timeMs = "1500";
    r2.media.push(v);
    r2.lastIssued.media = 2;
    r2.pins.push({ ...r2.pins[0], id: "p2", mediaId: "m2", frameMs: 1500 });
    r2.lastIssued.pin = 2;
    expect(validate(r2).map((f) => f.pointer)).toEqual(["/media/1/frames/1/timeMs"]);

    const r3 = example();
    r3.pins[0].id = "P1";
    r3.interpretations.p1 = structuredClone(r3.interpretations.p0);
    expect(validate(r3).map((f) => f.pointer)).toEqual(["/pins/0/id"]);
  });

  it("a malformed correction is reported once", () => {
    const found = broken((r) => (r.interpretations.p0.correction = 5));
    expect(found.map((f) => f.pointer)).toEqual(["/interpretations/p0/correction"]);
  });

  it("frames of an image are not parsed, even malformed ones", () => {
    const found = broken((r) => (r.media[0].frames = [{ timeMs: 0 }, {}]));
    expect(found.map((f) => f.pointer)).toEqual(["/media/0/frames"]);
  });

  it("control characters of any kind never reach a message", () => {
    for (const key of ["\u009b2J", "x\u007fy", "\u001b[2J"]) {
      const found = broken((r) => (r[key] = 1));
      expect(found).toHaveLength(1);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: that is what is tested.
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(found[0]?.message ?? "")).toBe(false);
    }
  });

  it("a missing field with a fixed set of values is required, not wrong", () => {
    const found = broken((r) => delete r.media[0].kind);
    expect(found.map((f) => f.message)).toEqual(["media[0].kind: is required."]);
    expect(broken((r) => delete r.formatVersion)[0]?.message).toBe("formatVersion: is required.");
  });
});

describe("reference: limits", () => {
  it("an id number above 2^53 - 1 is refused once, and lastIssued stays satisfiable", () => {
    const found = broken((r) => {
      r.media[0].id = `m${"9".repeat(400)}`;
      r.media[0].file = `${REF}/m1.webp`;
    });
    expect(found.every((f) => !f.message.includes("Infinity"))).toBe(true);
    expect(found.map((f) => f.pointer)).toContain("/media/0/id");
  });

  it("a list over its maximum stops the rules of the objects above it", () => {
    const found = broken((r) => {
      r.pins.push({ ...r.pins[0] });
      r.interpretations.p0.proposal.vocabulary = Array.from({ length: 51 }, (_, i) => `t${i}`);
    });
    expect(found.map((f) => f.pointer)).toEqual(["/interpretations/p0/proposal/vocabulary"]);
  });
});

describe("reference: more cascades", () => {
  it("a video whose frames is not a list does not make its pins fail", () => {
    for (const frames of [{}, null, "x"]) {
      const r = example();
      r.media.push({ ...video(), frames });
      r.lastIssued.media = 2;
      r.pins.push({ ...r.pins[0], id: "p2", mediaId: "m2", frameMs: 0 });
      r.lastIssued.pin = 2;
      expect(validate(r).map((f) => f.pointer)).toEqual(["/media/1/frames"]);
    }
  });

  it("a timestamp that names no real time is not compared", () => {
    const found = broken((r) => {
      r.createdAt = "2026-02-30T12:00:00.000Z";
      r.updatedAt = "2026-02-10T12:00:00.000Z";
    });
    expect(found.map((f) => f.pointer)).toEqual(["/createdAt"]);
  });

  it("a malformed correction is reported once: a string, an empty object and a number", () => {
    for (const correction of ["x", 5, [], {}]) {
      const found = broken((r) => (r.interpretations.p0.correction = correction));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((f) => !f.message.includes("must be null unless"))).toBe(true);
    }
    const valid = {
      summary: "x",
      vocabulary: [],
      keywords: [],
      screenTypes: [],
      components: [],
      aspects: [],
    };
    expectOne(
      broken((r) => (r.interpretations.p0.correction = valid)),
      "schema-violation",
      "/interpretations/p0/correction",
      'interpretations.p0.correction: must be null unless status is "corrected".',
    );
  });

  it("invalid keys say what is expected", () => {
    const zz = broken((r) => (r.interpretations.zz = structuredClone(r.interpretations.p0)));
    expect(zz[0]?.message).toContain("must be a piece id");
    const proto = example();
    Object.defineProperty(proto.interpretations, "__proto__", {
      value: 1,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(validate(proto)[0]?.message).toBe(
      'interpretations.__proto__: is not allowed; keys are "p0" or the id of a pin.',
    );
  });

  it("layout-changing characters in keys are escaped", () => {
    for (const key of ["\u202etxt.exe", "a\u2028b", "a\u200bb", "a\u2029b"]) {
      const found = broken((r) => (r[key] = 1));
      expect(found).toHaveLength(1);
      expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(found[0]?.message ?? "")).toBe(false);
    }
  });

  it("an infinite number is a number that is too large, not a wrong type", () => {
    const found = broken((r) => (r.media[0].bytes = Number.POSITIVE_INFINITY));
    expect(found.map((f) => f.message)).not.toContain("media[0].bytes: must be a number.");
    expect(found).toHaveLength(1);
  });
});

describe("reference: last cascades", () => {
  it("a type that disagrees with the kind does not also ask for another file name", () => {
    const wrongType = broken((r) => (r.media[0].type = "video/mp4"));
    expect(wrongType.map((f) => f.pointer)).toEqual(["/media/0/type"]);
    const r = example();
    r.media.push({ ...video(), type: "image/png" });
    r.lastIssued.media = 2;
    expect(validate(r).map((f) => f.pointer)).toEqual(["/media/1/type"]);
  });

  it("a malformed reviewedAt next to to-review is reported once", () => {
    const found = broken((r) => (r.interpretations.p0.reviewedAt = "nope"));
    expect(found.map((f) => f.pointer)).toEqual(["/interpretations/p0/reviewedAt"]);
  });

  it("a tag that breaks its own rule is not also reported as a repeat", () => {
    const found = broken((r) => (r.interpretations.p0.proposal.keywords = [" a", "a", " A"]));
    expect(found.map((f) => f.pointer).sort()).toEqual([
      "/interpretations/p0/proposal/keywords/0",
      "/interpretations/p0/proposal/keywords/2",
    ]);
  });

  it("an astral format character is written so that it names the same character", () => {
    const found = broken((r) => (r["a\u{e0041}"] = 1));
    expect(found[0]?.message).toContain("\\u{e0041}");
  });
});

describe("reference: last round", () => {
  it("__proto__ in interpretations does not hide the other issues", () => {
    const r = example();
    Object.defineProperty(r.interpretations, "__proto__", {
      value: 1,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    r.interpretations.zz = structuredClone(r.interpretations.p0);
    r.interpretations.p0.proposal.summary = "";
    expect(
      validate(r)
        .map((f) => f.pointer)
        .sort(),
    ).toEqual([
      "/interpretations/__proto__",
      "/interpretations/p0/proposal/summary",
      "/interpretations/zz",
    ]);
  });

  it("an unknown kind does not hide the file name rule", () => {
    const r = example();
    r.media[0].kind = "vidoe";
    r.media[0].type = "video/mp4";
    r.media[0].file = `${REF}/m1.webp`;
    r.pins = [];
    r.interpretations = {};
    r.lastIssued.pin = 1;
    expect(
      validate(r)
        .map((f) => f.pointer)
        .sort(),
    ).toEqual(["/media/0/file", "/media/0/kind"]);
  });
});

describe("reference: sixth round", () => {
  it("a value that is not a list but has a length gets the type issue only", () => {
    for (const patch of [
      { media: "" },
      { media: { length: 51 } },
      { pins: "x".repeat(501) },
      { pins: { length: 501 } },
    ]) {
      const found = validate({ ...example(), ...patch });
      const key = Object.keys(patch)[0];
      expect(found.filter((f) => f.pointer === `/${key}`).map((f) => f.message)).toEqual([
        `${key}: must be an array.`,
      ]);
    }
    const tags = broken((r) => (r.interpretations.p0.proposal.keywords = "x".repeat(51)));
    expect(tags.map((f) => f.message)).toEqual([
      "interpretations.p0.proposal.keywords: must be an array.",
    ]);
    const r = example();
    r.media.push({ ...video(), frames: { length: 1001 } });
    r.lastIssued.media = 2;
    expect(validate(r).map((f) => f.message)).toEqual(["media[1].frames: must be an array."]);
  });

  it("an unknown kind does not hide the other fields of the item", () => {
    const found = broken((r) => {
      r.media[0].kind = "vidoe";
      r.media[0].bytes = 0;
      r.media[0].sha256 = "X";
      r.media[0].extra = 1;
      r.media[0].id = "m01";
    });
    expect(found.map((f) => f.pointer).sort()).toEqual([
      "/media/0/bytes",
      "/media/0/extra",
      "/media/0/id",
      "/media/0/kind",
      "/media/0/sha256",
    ]);
  });

  it("an unknown kind does not hide frames that are not a list", () => {
    for (const frames of ["abc", {}, { length: 3 }]) {
      const found = broken((r) => {
        r.media[0].kind = "vidoe";
        r.media[0].frames = frames;
      });
      expect(found.map((f) => `${f.pointer}: ${f.message}`).sort()).toEqual([
        "/media/0/frames: media[0].frames: must be an array.",
        '/media/0/kind: media[0].kind: must be one of "image", "page", "video".',
      ]);
    }
    const missing = broken((r) => {
      r.media[0].kind = "vidoe";
      delete r.media[0].frames;
    });
    expect(missing.map((f) => f.message).sort()).toEqual([
      "media[0].frames: is required.",
      'media[0].kind: must be one of "image", "page", "video".',
    ]);
    expect(broken((r) => (r.media[0].kind = "vidoe")).map((f) => f.pointer)).toEqual([
      "/media/0/kind",
    ]);
  });

  it("types the frames of a media item as a list of frames", () => {
    // Fails to typecheck if the inferred type is `unknown`.
    const timeMs = (item: Reference["media"][number]): number[] => item.frames.map((f) => f.timeMs);
    expect(timeMs({ ...example().media[0], frames: [{ timeMs: 5 }] })).toEqual([5]);
  });

  it("frames of a video are still checked in full, with their paths", () => {
    const r = example();
    const v = video();
    v.frames[0].bytes = 0;
    delete v.frames[1].sha256;
    r.media.push(v);
    r.lastIssued.media = 2;
    expect(
      validate(r)
        .map((f) => `${f.pointer}: ${f.message}`)
        .sort(),
    ).toEqual([
      "/media/1/frames/0/bytes: media[1].frames[0].bytes: must be at least 1.",
      "/media/1/frames/1/sha256: media[1].frames[1].sha256: is required.",
    ]);
  });
});
