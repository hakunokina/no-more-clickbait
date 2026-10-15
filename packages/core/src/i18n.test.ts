import { describe, expect, it } from "vitest";
import {
  formatMessage,
  plural,
  resolveUiLang,
  tableMismatches,
  type MessageRef,
  type MessageTable,
} from "./i18n.js";
import { MANAGED_SETTING_FIELDS, SettingsSchema, type ManagedSettingKey } from "./schemas.js";
import { settingCopy } from "./setting-copy.js";

describe("resolveUiLang", () => {
  it("keeps an explicit choice", () => {
    expect(resolveUiLang("tr", ["en-US"])).toBe("tr");
    expect(resolveUiLang("en", ["tr-TR"])).toBe("en");
  });

  it("follows the OS's first language: Turkish when it is Turkish, else English", () => {
    expect(resolveUiLang("system", ["tr-TR", "en-US"])).toBe("tr");
    expect(resolveUiLang("system", ["tr"])).toBe("tr");
    expect(resolveUiLang("system", ["TR_tr"])).toBe("tr");
    expect(resolveUiLang("system", ["en-GB", "tr-TR"])).toBe("en");
    expect(resolveUiLang("system", ["de-DE"])).toBe("en");
    expect(resolveUiLang("system", ["tru"])).toBe("en");
    expect(resolveUiLang("system", [])).toBe("en");
  });
});

describe("message tables", () => {
  const en = { hello: "Hello", posts: (n: number) => `${n} posts` };
  const tr: MessageTable<typeof en> = { hello: "Merhaba", posts: (n) => `${n} gönderi` };

  it("formats a message by reference, with its arguments", () => {
    const ref: MessageRef<typeof en> = { key: "posts", args: [3] };
    expect(formatMessage(tr, ref)).toBe("3 gönderi");
    expect(formatMessage(en, { key: "hello" })).toBe("Hello");
  });

  it("finds keys and argument lists that differ", () => {
    expect(tableMismatches(en, tr)).toEqual([]);
    expect(tableMismatches(en, { hello: "x" })).toEqual(["posts"]);
    expect(tableMismatches(en, { hello: "x", posts: () => "x" })).toEqual(["posts"]);
    expect(tableMismatches({ hello: "x" }, { hello: "x", extra: "y" })).toEqual(["extra"]);
  });

  it("picks plural forms by the language's rules", () => {
    const forms = { one: "post", other: "posts" };
    expect([0, 1, 2].map((n) => plural("en", n, forms))).toEqual(["posts", "post", "posts"]);
  });
});

describe("setting copy", () => {
  it("has every managed setting in both languages, every choice labelled", () => {
    for (const key of Object.keys(MANAGED_SETTING_FIELDS) as ManagedSettingKey[]) {
      const field = MANAGED_SETTING_FIELDS[key];
      for (const lang of ["en", "tr"] as const) {
        const copy = settingCopy(lang, key);
        expect(copy.label.length, `${lang} ${key}`).toBeGreaterThan(0);
        expect(copy.description.length, `${lang} ${key}`).toBeGreaterThan(10);
        if (field.kind === "choice") {
          expect(Object.keys(copy.options ?? {}), `${lang} ${key}`).toEqual(
            field.options.map((option: { value: string }) => option.value),
          );
        }
      }
    }
    expect(settingCopy("en", "collectTarget").label).toBe("Posts to collect");
    expect(settingCopy("tr", "uiLanguage").options).toEqual({
      system: "Sistem dili",
      en: "English",
      tr: "Türkçe",
    });
  });

  it("defaults the UI language to the system's and keeps a saved choice", () => {
    expect(SettingsSchema.parse({}).uiLanguage).toBe("system");
    expect(SettingsSchema.parse({ uiLanguage: "tr" }).uiLanguage).toBe("tr");
    expect(SettingsSchema.safeParse({ uiLanguage: "de" }).success).toBe(false);
  });
});
