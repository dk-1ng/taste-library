import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { type Language, type MessageKey, pickLanguage, translate } from "./core";

export { isLanguage, LANGUAGES, type Language, type MessageKey } from "./core";

type I18n = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
};

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({
  initialLanguage,
  children,
}: {
  initialLanguage?: Language;
  children: ReactNode;
}) {
  const [language, setLanguage] = useState<Language>(
    () => initialLanguage ?? pickLanguage(globalThis.navigator?.languages ?? []),
  );
  const value = useMemo<I18n>(
    () => ({ language, setLanguage, t: (key, values) => translate(language, key, values) }),
    [language],
  );
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside an I18nProvider");
  return value;
}
