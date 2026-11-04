import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeededRandom, makeBmp, makeHtmlPage, makePng, withTempDir } from "./index.js";

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
});
