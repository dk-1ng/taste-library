import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import {
  createSeededRandom,
  fnv1a32,
  makeBmp,
  makeHtmlPage,
  makePng,
  makeStablePng,
  withTempDir,
} from "./index.js";

describe("seeded random", () => {
  it("repeats for the same seed and differs between seeds", () => {
    const a = createSeededRandom(7);
    const b = createSeededRandom(7);
    expect([a.int(1000), a.int(1000), a.int(1000)]).toEqual([
      b.int(1000),
      b.int(1000),
      b.int(1000),
    ]);
    expect(createSeededRandom(8).next()).not.toBe(createSeededRandom(7).next());
  });
});

describe("generated images", () => {
  it("makes PNGs of the requested size, identical for the same seed", () => {
    const png = makePng(5, 3, 42);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(5);
    expect(png.readUInt32BE(20)).toBe(3);
    expect(makePng(5, 3, 42).equals(png)).toBe(true);
    expect(makePng(5, 3, 43).equals(png)).toBe(false);
  });

  it("makes BMPs with the right header and size", () => {
    const bmp = makeBmp(3, 2, 1);
    expect(bmp.subarray(0, 2).toString("latin1")).toBe("BM");
    expect(bmp.readInt32LE(18)).toBe(3);
    expect(bmp.readInt32LE(22)).toBe(2);
    expect(bmp.length).toBe(54 + 12 * 2); // rows padded to 4 bytes
  });

  it("rejects invalid sizes", () => {
    expect(() => makePng(0, 4)).toThrow(RangeError);
  });
});

describe("byte-stable PNG", () => {
  const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

  /** The decoded pixels of an 8-bit RGB PNG with filter 0 in every row. */
  function decode(png: Buffer): { width: number; height: number; pixels: Buffer } {
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const idatLength = png.readUInt32BE(33);
    const idat = png.subarray(41, 41 + idatLength);
    expect(png.subarray(37, 41).toString("latin1")).toBe("IDAT");
    const raw = inflateSync(idat);
    const rows: Buffer[] = [];
    for (let y = 0; y < height; y++) {
      expect(raw[y * (width * 3 + 1)]).toBe(0);
      rows.push(raw.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)));
    }
    return { width, height, pixels: Buffer.concat(rows) };
  }

  it("decodes to the same pixels as makePng", () => {
    const stable = decode(makeStablePng(7, 5, 9));
    const normal = decode(makePng(7, 5, 9));
    expect(stable.width).toBe(7);
    expect(stable.height).toBe(5);
    expect(stable.pixels.equals(normal.pixels)).toBe(true);
  });

  it("splits image data larger than one stored block into several blocks", () => {
    const png = makeStablePng(200, 120, 3); // 72 120 bytes of raw data: two blocks
    const decoded = decode(png);
    expect(decoded.pixels.length).toBe(200 * 120 * 3);
    expect(decode(makePng(200, 120, 3)).pixels.equals(decoded.pixels)).toBe(true);
  });

  it("has the CRC-32 of every chunk right", () => {
    const png = makeStablePng(3, 2, 1);
    let offset = 8;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const body = png.subarray(offset + 4, offset + 8 + length);
      const crc = png.readUInt32BE(offset + 8 + length);
      expect(crc).toBe(crc32(body));
      offset += 12 + length;
    }
  });

  it("repeats for the same arguments and differs between seeds", () => {
    expect(makeStablePng(9, 9, 5).equals(makeStablePng(9, 9, 5))).toBe(true);
    expect(makeStablePng(9, 9, 5).equals(makeStablePng(9, 9, 6))).toBe(false);
  });

  it("rejects invalid sizes", () => {
    expect(() => makeStablePng(0, 4)).toThrow(RangeError);
  });

  it("never changes: the SHA-256 of a few outputs is pinned", () => {
    // If one of these fails, the golden libraries' recorded media checksums are no longer true.
    expect(sha256(makeStablePng(1, 1, 1))).toBe(
      "bce6bd3ad87d22bcd57c9217b0a3f9ea942cba75a28a7b6bbd6d3f2c5f2ae9e9",
    );
    expect(sha256(makeStablePng(16, 16, 42))).toBe(
      "4b3c584119d9ee2d146bfb693dbc7545e6c132c35b85d5077e140ebd4ae19a54",
    );
    expect(sha256(makeStablePng(64, 48, fnv1a32("ref-x/m1.png")))).toBe(
      "88f5185c229bf932c7e2d9cfb2545fbc8600bcc1cc407be969a214538bee2dae",
    );
  });

  it("hashes text with FNV-1a 32", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32("Usuário")).toBe(fnv1a32("Usuário"));
  });
});

describe("generated pages", () => {
  it("uses the requested line ending and escapes text", () => {
    const crlf = makeHtmlPage({ title: "A <b> & c", crlf: true });
    expect(crlf).toContain("\r\n");
    expect(crlf).toContain("A &#60;b&#62; &#38; c");
    expect(makeHtmlPage()).not.toContain("\r");
  });
});

describe("temporary directory", () => {
  it("has a non-ASCII path, supports file round trips, and is removed afterwards", async () => {
    let seen = "";
    await withTempDir(async (dir) => {
      seen = dir;
      expect(dir).toContain("Usuário");
      const file = join(dir, "ímagem.png");
      const png = makePng(2, 2);
      await writeFile(file, png);
      expect((await readFile(file)).equals(png)).toBe(true);
    });
    await expect(readFile(join(seen, "ímagem.png"))).rejects.toThrow();
  });

  it("finds a folder by either Unicode normalization form where the file system folds them", async () => {
    await withTempDir(async (dir) => {
      const nfc = "Usu\u00e1rio"; // precomposed (what the user types)
      const nfd = nfc.normalize("NFD"); // decomposed (what macOS may return)
      expect(nfd).not.toBe(nfc);
      await mkdir(join(dir, nfc));
      await writeFile(join(dir, nfc, "nota.txt"), "x");
      // The listing may return either form; both must name the same folder once normalized.
      const listed = (await readdir(dir)).find((name) => name.normalize("NFC") === nfc);
      expect(listed).toBeDefined();
      // Opening by the listed name always works.
      expect(await readFile(join(dir, listed as string, "nota.txt"), "utf8")).toBe("x");
      // Opening by the other form works only where the file system folds normalization (macOS);
      // elsewhere the two names are different files. Neither outcome may corrupt the data.
      const other = listed === nfc ? nfd : nfc;
      const viaOther = await readFile(join(dir, other, "nota.txt"), "utf8").catch(() => null);
      // APFS (macOS) folds the two forms; Linux and Windows keep them apart.
      expect(viaOther).toBe(process.platform === "darwin" ? "x" : null);
    });
  });
});
