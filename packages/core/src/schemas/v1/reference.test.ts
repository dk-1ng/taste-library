import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issuesFromZod } from "../../validation/zod-issues.js";
import { ReferenceSchema } from "./reference.js";

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

  it("reports one issue per rule broken", () => {
    const found = broken((r) => {
      r.pins[0].mediaId = "m9";
      r.pins[0].region.w = 0;
      r.pins[0].polarity = "x";
    });
    expect(found.map((f) => f.pointer).sort()).toEqual(["/pins/0/polarity", "/pins/0/region/w"]);
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
    expect(validate(r)).not.toEqual([]);
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
