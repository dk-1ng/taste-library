import { describe, expect, it } from "vitest";
import { catalogs, format, LANGUAGES, pickLanguage, translate } from "./core";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("message catalogs", () => {
  const reference = Object.keys(catalogs.en).sort();

  for (const language of LANGUAGES) {
    it(`${language} has exactly the keys of en`, () => {
      expect(Object.keys(catalogs[language]).sort()).toEqual(reference);
    });

    it(`${language} has no empty message`, () => {
      for (const [key, text] of Object.entries(catalogs[language])) {
        expect(text.trim(), key).not.toBe("");
      }
    });

    it(`${language} uses the same placeholders as en`, () => {
      for (const key of reference) {
        const k = key as keyof typeof catalogs.en;
        expect(placeholders(catalogs[language][k]), key).toEqual(placeholders(catalogs.en[k]));
      }
    });
  }
});

describe("pickLanguage", () => {
  it("prefers an exact supported tag", () => {
    expect(pickLanguage(["pt-BR", "en"])).toBe("pt-BR");
  });
  it("maps other Portuguese tags to pt-BR", () => {
    expect(pickLanguage(["pt-PT"])).toBe("pt-BR");
  });
  it("falls back to English", () => {
    expect(pickLanguage(["fr-FR", "de"])).toBe("en");
    expect(pickLanguage([])).toBe("en");
  });
});

describe("translate", () => {
  it("returns the message of the language", () => {
    expect(translate("pt-BR", "language.label")).toBe("Idioma");
    expect(translate("en", "language.label")).toBe("Language");
  });
});

describe("format", () => {
  it("fills placeholders", () => {
    expect(format("Hi {name}, {n} new", { name: "Ana", n: 2 })).toBe("Hi Ana, 2 new");
  });
  it("leaves a placeholder with no value", () => {
    expect(format("Hi {name}", {})).toBe("Hi {name}");
  });
  it("ignores inherited object properties", () => {
    expect(format("{constructor} {toString}", {})).toBe("{constructor} {toString}");
  });
});
