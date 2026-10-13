import assert from "node:assert/strict";
import { Script } from "node:vm";
import test from "node:test";
import server from "../src/index.mjs";

const getPage = (query = "", cookie = "") => server.fetch(new Request(`https://example.com/${query}`, {
  headers: { cookie },
}), {});

test("serves complete English markup with executable interactions and the same sections and resources", async () => {
  const chinese = await (await getPage()).text();
  const response = await getPage("?build=026&lang=en");
  const english = await response.text();
  assert.equal(response.headers.get("content-language"), "en");
  assert.match(english, /<html lang="en">/);
  assert.match(chinese, /睡眠满八小时/);
  assert.match(english, /&gt;850K/);
  assert.match(english, /&gt;4M/);
  assert.doesNotMatch(english, /&amp;gt;/);
  const markup = english.split("</main><script>")[0];
  const withoutSwitcher = markup.replace(/<a class="language-switch"[\s\S]*?<\/a>/, "");
  assert.doesNotMatch(withoutSwitcher, /\p{Script=Han}/u, "English static text and accessible labels must be complete");
  const resources = html => [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => match[1]).filter(value => !value.startsWith("?lang="));
  assert.deepEqual(resources(english), resources(chinese));
  const sections = html => [...html.matchAll(/<section[^>]*id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sections(english), sections(chinese));
  assert.ok(sections(english).includes("market"));
  for (const html of [chinese, english]) {
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
  }
});

test("remembers language, permits an explicit switch back, and ignores unsupported input", async () => {
  const saved = await getPage("?build=026", "other=1; momoLanguage=en");
  assert.equal(saved.headers.get("content-language"), "en");
  assert.match(saved.headers.get("set-cookie"), /^momoLanguage=en;/);
  const switched = await getPage("?lang=zh", "momoLanguage=en");
  assert.equal(switched.headers.get("content-language"), "zh-CN");
  const invalid = await getPage("?lang=%3Cscript%3E");
  assert.equal(invalid.headers.get("content-language"), "zh-CN");
  assert.match(invalid.headers.get("cache-control"), /no-store/);
});
