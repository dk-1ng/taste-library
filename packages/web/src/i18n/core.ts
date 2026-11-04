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
    if (tag.toLowerCase().startsWith("pt")) return "pt-BR";
    if (tag.toLowerCase().startsWith("en")) return "en";
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
