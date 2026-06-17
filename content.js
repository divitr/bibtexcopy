const BIBTEX_COPY_DEFAULTS = {
  enabled: true,
  showToast: true
};

const BIBTEX_ENTRY_RE = /@(?:article|book|booklet|conference|dataset|inbook|incollection|inproceedings|manual|mastersthesis|misc|online|patent|phdthesis|proceedings|report|techreport|thesis|unpublished)\s*[{(]/i;
const BIBTEX_URL_RE = /(?:^|[/?&#._=-])(?:bibtex|bib|citation|citations|cite|export|downloadCitation)(?:$|[/?&#._=-])/i;
const BIBTEX_TEXT_RE = /\b(?:bibtex|bib\s*tex|export\s+bib|download\s+bib|citation\s+download|download\s+citation)\b/i;

let settings = { ...BIBTEX_COPY_DEFAULTS };

chrome.storage.sync.get(BIBTEX_COPY_DEFAULTS, (stored) => {
  settings = { ...BIBTEX_COPY_DEFAULTS, ...stored };
  postSettingsToPageHook();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") {
    return;
  }

  for (const [key, change] of Object.entries(changes)) {
    settings[key] = change.newValue;
  }
  postSettingsToPageHook();
});

document.addEventListener("click", handleClickCapture, true);
window.addEventListener("message", handleInjectedMessage);

async function handleClickCapture(event) {
  if (!settings.enabled || event.defaultPrevented || event.button !== 0) {
    return;
  }

  const candidate = getClickCandidate(event);
  if (!candidate || !candidate.url || !candidate.shouldBlock) {
    if (!candidate || !candidate.text || !candidate.shouldBlock) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    await copyKnownBibtexAndToast(candidate.text);
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  await fetchCopyAndToast(candidate.url);
}

function getClickCandidate(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const nodes = path.length ? path : getNodePath(event.target);

  for (const node of nodes) {
    if (!(node instanceof Element)) {
      continue;
    }

    const href = getElementHref(node);
    const downloadName = getDownloadName(node);
    const text = getElementSignalText(node);

    if (!href && !downloadName) {
      continue;
    }

    const confidence = scoreCandidate({ href, downloadName, text });
    if (confidence >= 3) {
      return {
        url: href,
        shouldBlock: true
      };
    }
  }

  const embeddedBibtex = getEmbeddedBibtexCandidate(nodes);
  if (embeddedBibtex) {
    return {
      text: embeddedBibtex,
      shouldBlock: true
    };
  }

  const metadataBibtex = getMetadataBibtexCandidate(nodes);
  if (metadataBibtex) {
    return {
      text: metadataBibtex,
      shouldBlock: true
    };
  }

  return null;
}

function getNodePath(node) {
  const path = [];
  let current = node;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  return path;
}

function getElementHref(element) {
  if (element instanceof HTMLAnchorElement && element.href) {
    return element.href;
  }

  const closestLink = element.closest ? element.closest("a[href]") : null;
  if (closestLink && closestLink.href) {
    return closestLink.href;
  }

  const dataUrl = element.getAttribute("data-url") || element.getAttribute("data-href") || element.getAttribute("data-download-url");
  if (dataUrl) {
    try {
      return new URL(dataUrl, location.href).href;
    } catch (_error) {
      return "";
    }
  }

  return "";
}

function getDownloadName(element) {
  const direct = element.getAttribute("download");
  if (direct !== null) {
    return direct || "download";
  }

  const closestDownload = element.closest ? element.closest("[download]") : null;
  if (closestDownload) {
    return closestDownload.getAttribute("download") || "download";
  }

  return "";
}

function getElementSignalText(element) {
  const labels = [
    element.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-action"),
    element.getAttribute("data-testid"),
    element.getAttribute("class"),
    element.id
  ];

  return labels.filter(Boolean).join(" ").slice(0, 1000);
}

function getEmbeddedBibtexCandidate(nodes) {
  const clickedElement = nodes.find((node) => node instanceof Element);
  if (!clickedElement) {
    return "";
  }

  const clickedText = getElementSignalText(clickedElement);
  if (!/\b(?:download|copy|clipboard)\b/i.test(clickedText)) {
    return "";
  }

  const localContainers = [];
  for (const node of nodes) {
    if (!(node instanceof Element)) {
      continue;
    }

    const text = (node.innerText || node.textContent || "").trim();
    if (
      text &&
      text.length <= 25000 &&
      BIBTEX_ENTRY_RE.test(text) &&
      /\bBibTeX\b/i.test(text) &&
      /\b(?:download|copy|clipboard)\b/i.test(text)
    ) {
      localContainers.push(node);
    }
  }

  for (const container of localContainers) {
    const bibtex = extractBibtexFromElement(container);
    if (bibtex && isControlNearBibtex(clickedElement, container, bibtex)) {
      return bibtex;
    }
  }

  const nearbyBibtex = findNearbyBibtex(clickedElement);
  return nearbyBibtex || "";
}

function extractBibtexFromElement(element) {
  const codeLike = Array.from(element.querySelectorAll("pre, code, textarea"))
    .map((node) => node.value || node.innerText || node.textContent || "")
    .find((text) => BIBTEX_ENTRY_RE.test(text));

  if (codeLike) {
    return normalizeBibtexText(codeLike);
  }

  return normalizeBibtexText(element.innerText || element.textContent || "");
}

function normalizeBibtexText(text) {
  const value = (text || "").trim();
  const firstEntry = value.search(BIBTEX_ENTRY_RE);
  if (firstEntry < 0) {
    return "";
  }

  return value.slice(firstEntry).trim();
}

function isControlNearBibtex(clickedElement, container, bibtex) {
  if (container === document.body || container === document.documentElement) {
    return false;
  }

  const clickRect = clickedElement.getBoundingClientRect();
  const bibtexNode = Array.from(container.querySelectorAll("pre, code, textarea"))
    .find((node) => BIBTEX_ENTRY_RE.test(node.value || node.innerText || node.textContent || ""));

  if (!bibtexNode) {
    return true;
  }

  const bibtexRect = bibtexNode.getBoundingClientRect();
  const verticalDistance = Math.abs(clickRect.top - bibtexRect.bottom);
  return verticalDistance < Math.max(260, Math.min(900, bibtex.length / 3));
}

function findNearbyBibtex(clickedElement) {
  const walkerRoot = clickedElement.closest("section, article, main, div, td, li") || document.body;
  const codeNodes = Array.from(walkerRoot.querySelectorAll("pre, code, textarea"))
    .filter((node) => BIBTEX_ENTRY_RE.test(node.value || node.innerText || node.textContent || ""));

  if (!codeNodes.length) {
    return "";
  }

  const clickRect = clickedElement.getBoundingClientRect();
  const nearest = codeNodes
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        node,
        distance: Math.abs(clickRect.top - rect.bottom) + Math.abs(clickRect.left - rect.left) * 0.1
      };
    })
    .sort((a, b) => a.distance - b.distance)[0];

  if (!nearest || nearest.distance > 900) {
    return "";
  }

  return normalizeBibtexText(nearest.node.value || nearest.node.innerText || nearest.node.textContent || "");
}

function getMetadataBibtexCandidate(nodes) {
  const clickedElement = nodes.find((node) => node instanceof Element);
  if (!clickedElement) {
    return "";
  }

  const clickedText = getElementSignalText(clickedElement);
  const surroundingText = getSurroundingSignalText(clickedElement);
  const hasBibtexSignal = /\bbib\s*tex\b/i.test(clickedText) || (
    /\b(?:export|download|save|copy)\b/i.test(clickedText) &&
    /\bbib\s*tex\b/i.test(surroundingText)
  );

  if (!hasBibtexSignal) {
    return "";
  }

  return buildBibtexFromCitationMetadata();
}

function getSurroundingSignalText(element) {
  const container = element.closest("dialog, [role='dialog'], form, section, article, div") || element;
  return (container.innerText || container.textContent || "").slice(0, 4000);
}

function buildBibtexFromCitationMetadata() {
  const title = getCitationMeta("citation_title");
  const doi = getCitationMeta("citation_doi");
  const pii = getCitationMeta("citation_pii");
  const authors = getCitationMetas("citation_author");

  if (!title || (!doi && !pii && !authors.length)) {
    return "";
  }

  const date = getCitationMeta("citation_publication_date") || getCitationMeta("citation_online_date") || getCitationMeta("citation_date");
  const year = ((date || "").match(/\d{4}/) || [])[0] || "";
  const firstPage = getCitationMeta("citation_firstpage");
  const lastPage = getCitationMeta("citation_lastpage");
  const pages = firstPage && lastPage && firstPage !== lastPage ? `${firstPage}--${lastPage}` : firstPage;

  const fields = [
    ["title", title],
    ["author", authors.join(" and ")],
    ["journal", getCitationMeta("citation_journal_title")],
    ["year", year],
    ["volume", getCitationMeta("citation_volume")],
    ["number", getCitationMeta("citation_issue")],
    ["pages", pages],
    ["doi", doi],
    ["url", getCitationMeta("citation_fulltext_html_url") || location.href]
  ].filter(([, value]) => value);

  if (!fields.length) {
    return "";
  }

  const key = buildCitationKey({ authors, year, doi, pii, title });
  const body = fields.map(([name, value]) => `  ${name} = {${cleanBibtexField(value)}}`).join(",\n");
  return `@article{${key},\n${body}\n}`;
}

function getCitationMeta(name) {
  const element = document.querySelector(`meta[name="${cssEscape(name)}"], meta[property="${cssEscape(name)}"]`);
  return element ? (element.getAttribute("content") || "").trim() : "";
}

function getCitationMetas(name) {
  return Array.from(document.querySelectorAll(`meta[name="${cssEscape(name)}"], meta[property="${cssEscape(name)}"]`))
    .map((element) => (element.getAttribute("content") || "").trim())
    .filter(Boolean);
}

function buildCitationKey({ authors, year, doi, pii, title }) {
  const authorPart = authors.length ? authors[0].split(/[\s,]+/).filter(Boolean).pop() : title.split(/\s+/)[0];
  const stablePart = doi || pii || title;
  const suffix = stablePart.split(/[/.]/).filter(Boolean).pop() || stablePart;
  return cleanCitationKey(`${authorPart || "citation"}${year || ""}${suffix}`).slice(0, 80) || "citation";
}

function cleanCitationKey(value) {
  return String(value || "").replace(/[^A-Za-z0-9_:-]+/g, "");
}

function cleanBibtexField(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/[{}]/g, "").trim();
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/"/g, "\\\"");
}

function scoreCandidate({ href, downloadName, text }) {
  let score = 0;
  const url = href || "";
  const filename = getLikelyFilename(url, downloadName);

  if (/\.bib(?:$|[?#])/i.test(url) || /\.bib$/i.test(filename)) {
    score += 3;
  }

  if (downloadName && /(?:\.bib$|bib|citation|cite)/i.test(downloadName)) {
    score += 2;
  }

  if (BIBTEX_URL_RE.test(url)) {
    score += 1;
  }

  if (BIBTEX_TEXT_RE.test(text)) {
    score += 2;
  }

  if (/\b(?:ris|endnote|refman)\b/i.test(url) && !/bib/i.test(url + text + downloadName)) {
    score -= 2;
  }

  return score;
}

function getLikelyFilename(url, downloadName) {
  if (downloadName && downloadName !== "download") {
    return downloadName;
  }

  try {
    const parsed = new URL(url, location.href);
    return parsed.pathname.split("/").pop() || "";
  } catch (_error) {
    return "";
  }
}

async function fetchCopyAndToast(url) {
  showToast("Copying BibTeX...");

  try {
    if (/^(?:blob|data):/i.test(url)) {
      const directText = await fetchLocalBibtex(url);
      await copyText(directText);
      showToast("BibTeX copied");
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "FETCH_BIBTEX",
      url,
      pageUrl: location.href
    });

    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Could not copy BibTeX.", true);
      return;
    }

    await copyText(response.text);
    showToast("BibTeX copied");
  } catch (error) {
    showToast(error && error.message ? error.message : "Could not copy BibTeX.", true);
  }
}

async function copyKnownBibtexAndToast(text) {
  showToast("Copying BibTeX...");

  try {
    await copyText(text);
    showToast("BibTeX copied");
  } catch (error) {
    showToast(error && error.message ? error.message : "Could not copy BibTeX.", true);
  }
}

async function fetchLocalBibtex(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Citation request failed (${response.status}).`);
  }

  const text = (await response.text()).trim();
  if (!BIBTEX_ENTRY_RE.test(text)) {
    throw new Error("The response did not look like BibTeX.");
  }

  const firstEntry = text.search(BIBTEX_ENTRY_RE);
  return firstEntry > 0 ? text.slice(firstEntry).trim() : text;
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.documentElement.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function showToast(message, isError = false) {
  if (!settings.showToast || !document.documentElement) {
    return;
  }

  let toast = document.getElementById("bibtex-copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "bibtex-copy-toast";
    const shadow = toast.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          pointer-events: none;
          font-family: Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif;
        }
        .toast {
          max-width: min(360px, calc(100vw - 32px));
          padding: 9px 11px;
          border: 1px solid #eee;
          border-radius: 4px;
          background: #fafafa;
          color: #4a4a4a;
          box-shadow: 0 8px 26px rgba(0, 0, 0, 0.12);
          font-size: 14px;
          line-height: 1.4;
          opacity: 0;
          transform: translateY(6px);
          transition: opacity 150ms ease, transform 150ms ease;
          word-break: break-word;
        }
        .toast[data-visible="true"] {
          opacity: 1;
          transform: translateY(0);
        }
        .toast[data-error="true"] {
          border-color: #d9b9b9;
          color: #7b3636;
        }
        @media (prefers-color-scheme: dark) {
          .toast {
            border-color: #323235;
            background: #151516;
            color: #ceced2;
            box-shadow: 0 8px 26px rgba(0, 0, 0, 0.34);
          }
          .toast[data-error="true"] {
            border-color: #62383c;
            color: #d6a3a3;
          }
        }
      </style>
      <div class="toast" role="status" aria-live="polite"></div>
    `;
    document.documentElement.appendChild(toast);
  }

  const toastBody = toast.shadowRoot.querySelector(".toast");
  toastBody.textContent = message;
  toastBody.dataset.error = String(Boolean(isError));
  toastBody.dataset.visible = "true";

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    if (toastBody) {
      toastBody.dataset.visible = "false";
    }
  }, isError ? 3600 : 2200);
}

async function handleInjectedMessage(event) {
  if (event.source !== window || !event.data || event.data.source !== "bibtex-copy-page-hook") {
    return;
  }

  if (event.data.type === "HOOK_READY") {
    postSettingsToPageHook();
    return;
  }

  if (!settings.enabled || event.data.type !== "BIBTEX_GENERATED_DOWNLOAD" || !BIBTEX_ENTRY_RE.test(event.data.text || "")) {
    return;
  }

  try {
    await copyText(event.data.text.trim());
    showToast("BibTeX copied");
  } catch (error) {
    showToast(error && error.message ? error.message : "Could not copy BibTeX.", true);
  }
}

function postSettingsToPageHook() {
  window.postMessage({
    source: "bibtex-copy-content",
    type: "SETTINGS",
    enabled: Boolean(settings.enabled)
  }, "*");
}
