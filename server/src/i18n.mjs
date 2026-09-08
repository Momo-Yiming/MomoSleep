import { englishCopy } from "./i18n-static.mjs";

const englishPattern = new RegExp(Object.keys(englishCopy)
  .sort((a, b) => b.length - a.length)
  .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|"), "g");
const escapeHTML = value => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

export function requestLanguage(request) {
  const explicit = new URL(request.url).searchParams.get("lang");
  if (explicit === "en" || explicit === "zh") return explicit;
  return /(?:^|;\s*)momoLanguage=en(?:;|$)/.test(request.headers.get("cookie") || "") ? "en" : "zh";
}

// Translate only the known presentation markup; scripts and API data keep their own display translations.
export function localizePage(html, language) {
  if (language !== "en") return html;
  const scriptStart = html.indexOf("</main><script>");
  const markup = html.slice(0, scriptStart).replace('lang="zh-CN"', 'lang="en"');
  return markup.replace(englishPattern, text => escapeHTML(englishCopy[text])) + html.slice(scriptStart);
}
