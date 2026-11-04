import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "./App";
import { catalogs } from "./i18n/core";
import { I18nProvider } from "./i18n/index";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = undefined;
  root = undefined;
});

async function mount(initialLanguage: "en" | "pt-BR") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider initialLanguage={initialLanguage}>
        <App />
      </I18nProvider>,
    );
  });
  return host;
}

describe("App", () => {
  it("renders in English", async () => {
    const el = await mount("en");
    expect(el.querySelector("h1")?.textContent).toBe(catalogs.en["app.title"]);
    expect(document.documentElement.lang).toBe("en");
  });

  it("renders in Portuguese", async () => {
    const el = await mount("pt-BR");
    expect(el.querySelector("h1")?.textContent).toBe(catalogs["pt-BR"]["app.title"]);
    expect(document.documentElement.lang).toBe("pt-BR");
  });

  it("switches language from the selector", async () => {
    const el = await mount("en");
    const select = el.querySelector("select");
    if (!select) throw new Error("no language selector");
    await act(async () => {
      select.value = "pt-BR";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(el.querySelector("h1")?.textContent).toBe(catalogs["pt-BR"]["app.title"]);
    expect(document.title).toBe(catalogs["pt-BR"]["app.title"]);
  });
});
