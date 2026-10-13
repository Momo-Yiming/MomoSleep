import assert from "node:assert/strict";
import { Script } from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import server from "../src/index.mjs";
import { appPage } from "../src/app-page.mjs";

test("the standalone app has runnable Chinese and English pages without the marketing sections", async () => {
  for (const language of ["zh", "en"]) {
    const response = await server.fetch(new Request(`https://example.com/app?lang=${language}`), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-language"), language === "en" ? "en" : "zh-CN");
    assert.match(response.headers.get("set-cookie"), new RegExp(`^momoLanguage=${language};`));
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const html = await response.text();
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /data-tab="rewards"/);
    assert.doesNotMatch(html, /id="(?:team|market|stepn|external-value)"/);
    assert.doesNotMatch(html, /momo-analytics\.js/);
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
  }
});

test("the app client survives the same bundling and name transforms used by Workers", async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("wrangler/package.json"))("esbuild");
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/app-page.mjs", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, keepNames: true, minify: true });
  const compiled = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
  for (const language of ["zh", "en"]) {
    assert.equal(compiled.appPage(language), appPage(language));
    const scripts = [...compiled.appPage(language).matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotMatch(scripts[0][1], /\b__name\b/);
    new Script(scripts[0][1]);
  }
});

test("app links, manifest and icon work through the existing server with remembered language", async () => {
  const response = await server.fetch(new Request("https://example.com/app/", { headers: { cookie: "momoLanguage=en" } }), {});
  assert.equal(response.headers.get("content-language"), "en");
  const manifestResponse = await server.fetch(new Request("https://example.com/app/manifest.webmanifest?lang=en"), {});
  assert.equal(manifestResponse.headers.get("content-type"), "application/manifest+json");
  const manifest = await manifestResponse.json();
  assert.equal(manifest.start_url, "/app?lang=en");
  assert.equal(manifest.display, "standalone");
  const icon = await server.fetch(new Request("https://example.com" + manifest.icons[0].src), {});
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type"), /image\/svg\+xml/);
  for (const language of ["zh", "en"]) {
    const home = await (await server.fetch(new Request(`https://example.com/?lang=${language}`), {})).text();
    assert.match(home, /class="opening-app" href="\/app"/);
    assert.match(home, language === "en" ? /Try the MOMO App/ : /体验 MOMO App/);
  }
});
