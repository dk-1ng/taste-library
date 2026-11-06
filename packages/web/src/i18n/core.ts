/**
 * The translation layer (docs/design.md section 12): original code, no dependency. One message
 * file per language: `messages.en.ts` is the reference and defines the `MessageKey` type, and
 * `messages.pt-BR.ts` is typed `Record<MessageKey, string>`, so `tsc` refuses a catalog that
 * lacks a key. `translate(language, key, values)` fills `{name}` placeholders; React components
 * get `t("key")` from `I18nProvider` and `useI18n()` in `./index.tsx` and never contain literal
 * user-facing text. `core.test.ts` checks that every catalog has the keys of `en`, no empty
 * message and the same placeholders.
 */
import { en, type MessageKey } from "./messages.en";
import { ptBR } from "./messages.pt-BR";

export type { MessageKey };

export const LANGUAGES = ["en", "pt-BR"] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "en";

export const catalogs: Record<Language, Record<MessageKey, string>> = {
  en,
  "pt-BR": ptBR,
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** Picks the first supported language from browser preferences (for example `pt-BR`, `pt`). */
export function pickLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    if (isLanguage(tag)) return tag;
    const lower = tag.toLowerCase();
    if (lower === "pt" || lower.startsWith("pt-")) return "pt-BR";
    if (lower === "en" || lower.startsWith("en-")) return "en";
  }
  return DEFAULT_LANGUAGE;
}

/** Looks up a message and fills `{name}` placeholders. */
export function format(template: string, values: Readonly<Record<string, string | number>>) {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}

export function translate(
  language: Language,
  key: MessageKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return format(catalogs[language][key], values);
}
