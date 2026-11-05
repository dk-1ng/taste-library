import { describe, expect, it } from "vitest";
import { differsBesidesUpdatedAt, laterOf, stampFile } from "./timestamps.js";

const NOW = "2026-11-05T10:00:00.000Z";
const OLD = "2026-11-01T10:00:00.000Z";

describe("laterOf", () => {
  it("returns the later of two timestamps", () => {
    expect(laterOf(OLD, NOW)).toBe(NOW);
    expect(laterOf(NOW, OLD)).toBe(NOW);
    expect(laterOf(NOW, NOW)).toBe(NOW);
  });
});

describe("differsBesidesUpdatedAt", () => {
  it("sets every updatedAt aside, at any depth", () => {
    const a = { updatedAt: OLD, terms: [{ id: "t", updatedAt: OLD, x: 1 }] };
    const b = { updatedAt: NOW, terms: [{ id: "t", updatedAt: NOW, x: 1 }] };
    expect(differsBesidesUpdatedAt(a, b)).toBe(false);
    expect(differsBesidesUpdatedAt(a, { ...b, terms: [{ id: "t", updatedAt: NOW, x: 2 }] })).toBe(
      true,
    );
  });
});

describe("stampFile", () => {
  it("stamps a new file and its entries with now", () => {
    const next = {
      terms: [{ id: "t1", createdAt: OLD, updatedAt: OLD, v: 1 }],
    };
    expect(stampFile("glossary", null, next, NOW)).toEqual({
      terms: [{ id: "t1", createdAt: NOW, updatedAt: NOW, v: 1 }],
    });
  });

  it("moves updatedAt of a changed entry only", () => {
    const previous = {
      terms: [
        { id: "t1", createdAt: OLD, updatedAt: OLD, v: 1 },
        { id: "t2", createdAt: OLD, updatedAt: OLD, v: 1 },
      ],
    };
    const next = {
      terms: [
        { id: "t1", createdAt: OLD, updatedAt: OLD, v: 2 },
        { id: "t2", createdAt: OLD, updatedAt: OLD, v: 1 },
      ],
    };
    expect(stampFile("glossary", previous, next, NOW)).toEqual({
      terms: [
        { id: "t1", createdAt: OLD, updatedAt: NOW, v: 2 },
        { id: "t2", createdAt: OLD, updatedAt: OLD, v: 1 },
      ],
    });
  });

  it("never sets updatedAt before createdAt (clock skew)", () => {
    const future = "2030-01-01T00:00:00.000Z";
    const previous = { createdAt: future, updatedAt: future, name: "a" };
    const next = { createdAt: future, updatedAt: future, name: "b" };
    expect(stampFile("project", previous, next, NOW)).toEqual({
      createdAt: future,
      updatedAt: future,
      name: "b",
    });
  });

  it("never sets an entry's updatedAt before its createdAt (clock skew)", () => {
    const future = "2030-01-01T00:00:00.000Z";
    const previous = { terms: [{ id: "t1", createdAt: future, updatedAt: future, v: 1 }] };
    const next = { terms: [{ id: "t1", createdAt: future, updatedAt: future, v: 2 }] };
    expect(stampFile("glossary", previous, next, NOW)).toEqual({
      terms: [{ id: "t1", createdAt: future, updatedAt: future, v: 2 }],
    });
  });

  it("gives a new pin createdAt now and keeps an old one", () => {
    const previous = { updatedAt: OLD, createdAt: OLD, pins: [{ id: "pin-1", createdAt: OLD }] };
    const next = {
      updatedAt: OLD,
      createdAt: OLD,
      pins: [
        { id: "pin-1", createdAt: OLD },
        { id: "pin-2", createdAt: OLD },
      ],
    };
    expect(stampFile("reference", previous, next, NOW)).toEqual({
      createdAt: OLD,
      updatedAt: NOW,
      pins: [
        { id: "pin-1", createdAt: OLD },
        { id: "pin-2", createdAt: NOW },
      ],
    });
  });

  it("gives a library only createdAt", () => {
    expect(stampFile("library", null, { id: "x", createdAt: OLD }, NOW)).toEqual({
      id: "x",
      createdAt: NOW,
    });
  });
});
