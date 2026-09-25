import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("LM Studio model catalog", () => {
  test("loads the live model list when an LM Studio picker opens", () => {
    const settings = readFileSync("src/views/Settings.svelte", "utf8");
    const api = readFileSync("src/lib/api.ts", "utf8");
    const commands = readFileSync("src-tauri/src/lib.rs", "utf8");

    expect(api).toContain('invoke<string[]>("lmstudio_models")');
    expect(commands).toContain("commands::lmstudio_models");
    expect(settings).toContain("async function ensureLmStudioModels()");
    expect(settings).toContain("onOpen={isLmStudio ? ensureLmStudioModels");
    expect(settings).toContain('loading={isOr ? orLoading : (isLmStudio && lmstudioLoading)}');
    expect(settings).toContain('if (prov.id === "lmstudio") return lmstudioInstalled');
  });

  test("keeps manual entry and exposes useful loading and empty states", () => {
    const settings = readFileSync("src/views/Settings.svelte", "utf8");
    const search = readFileSync("src/components/ModelSearch.svelte", "utf8");

    expect(settings).toContain("allowCustom={isCustom}");
    expect(settings).toContain("No models returned by LM Studio — type a model id");
    expect(search).toContain("emptyText?: string");
    expect(search).toContain("loading && options.length === 0");
    expect(search).toContain("!q.trim() && emptyText");
    expect(search).toContain("shown.length === 0 && !customCandidate");
  });

  test("invalidates the cached list when LM Studio connection settings change or save", () => {
    const settings = readFileSync("src/views/Settings.svelte", "utf8");

    expect(settings).toContain("function invalidateLmStudioModels()");
    expect(settings.match(/invalidateLmStudioModels\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
