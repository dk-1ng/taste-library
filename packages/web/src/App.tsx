import { useEffect } from "react";
import { isLanguage, LANGUAGES, useI18n } from "./i18n/index";

export function App() {
  const { language, setLanguage, t } = useI18n();

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t("app.title");
  }, [language, t]);

  return (
    <main>
      <h1>{t("app.title")}</h1>
      <p>{t("app.tagline")}</p>
      <p>{t("app.welcome")}</p>
      <label>
        {t("language.label")}{" "}
        <select
          value={language}
          onChange={(event) => {
            if (isLanguage(event.target.value)) setLanguage(event.target.value);
          }}
        >
          {LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {t(`language.${code}`)}
            </option>
          ))}
        </select>
      </label>
    </main>
  );
}
