const BIBTEX_ENTRY_RE = /@(?:article|book|booklet|conference|dataset|inbook|incollection|inproceedings|manual|mastersthesis|misc|online|patent|phdthesis|proceedings|report|techreport|thesis|unpublished)\s*[{(]/i;
const HTML_RE = /^\s*<!doctype html|^\s*<html[\s>]/i;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    enabled: true,
    showToast: true
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "FETCH_BIBTEX") {
    fetchBibtex(message.url, message.pageUrl)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : "Could not fetch BibTeX."
        });
      });
    return true;
  }

  return false;
});

async function fetchBibtex(url, pageUrl) {
  if (!url) {
    return { ok: false, error: "No citation URL found." };
  }

  const targetUrl = new URL(url, pageUrl || undefined).href;
  const response = await fetch(targetUrl, {
    credentials: "include",
    redirect: "follow",
    cache: "no-store"
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `Citation request failed (${response.status}).`
    };
  }

  const text = await response.text();
  const bibtex = extractBibtex(text);

  if (!bibtex) {
    return {
      ok: false,
      error: "The response did not look like BibTeX."
    };
  }

  return {
    ok: true,
    text: bibtex
  };
}

function extractBibtex(text) {
  if (!text || typeof text !== "string") {
    return "";
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  if (BIBTEX_ENTRY_RE.test(trimmed)) {
    const firstEntry = trimmed.search(BIBTEX_ENTRY_RE);
    return firstEntry > 0 ? trimmed.slice(firstEntry).trim() : trimmed;
  }

  if (HTML_RE.test(trimmed)) {
    const textareaMatch = trimmed.match(/<textarea[^>]*>([\s\S]*?@(?:article|book|booklet|conference|dataset|inbook|incollection|inproceedings|manual|mastersthesis|misc|online|patent|phdthesis|proceedings|report|techreport|thesis|unpublished)[\s\S]*?)<\/textarea>/i);
    if (textareaMatch) {
      const decoded = decodeHtml(textareaMatch[1]);
      return BIBTEX_ENTRY_RE.test(decoded) ? decoded.trim() : "";
    }

    const preMatch = trimmed.match(/<pre[^>]*>([\s\S]*?@(?:article|book|booklet|conference|dataset|inbook|incollection|inproceedings|manual|mastersthesis|misc|online|patent|phdthesis|proceedings|report|techreport|thesis|unpublished)[\s\S]*?)<\/pre>/i);
    if (preMatch) {
      const decoded = decodeHtml(preMatch[1]);
      return BIBTEX_ENTRY_RE.test(decoded) ? decoded.trim() : "";
    }
  }

  return "";
}

function decodeHtml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
