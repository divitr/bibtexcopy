(function installBibtexCopyHook() {
  if (window.__bibtexCopyHookInstalled) {
    return;
  }
  window.__bibtexCopyHookInstalled = true;

  const BIBTEX_ENTRY_RE = /@(?:article|book|booklet|conference|dataset|inbook|incollection|inproceedings|manual|mastersthesis|misc|online|patent|phdthesis|proceedings|report|techreport|thesis|unpublished)\s*[{(]/i;
  const generatedTextByUrl = new Map();
  const generatedTextPromiseByUrl = new Map();
  const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
  const nativeClick = HTMLAnchorElement.prototype.click;
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  const nativeWindowOpen = window.open.bind(window);
  const nativeLocationAssign = Location.prototype.assign;
  const nativeLocationReplace = Location.prototype.replace;

  let enabled = true;
  let lastCitationIntentAt = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "bibtex-copy-content") {
      return;
    }

    if (event.data.type === "SETTINGS") {
      enabled = Boolean(event.data.enabled);
    }
  });

  URL.createObjectURL = function createObjectURL(value) {
    const objectUrl = nativeCreateObjectUrl(value);
    if (value instanceof Blob) {
      const textPromise = value.text().then((text) => {
        if (BIBTEX_ENTRY_RE.test(text)) {
          const bibtex = normalizeBibtex(text);
          generatedTextByUrl.set(objectUrl, bibtex);
          return bibtex;
        }
        return "";
      }).catch(() => "");
      generatedTextPromiseByUrl.set(objectUrl, textPromise);
    }
    return objectUrl;
  };

  URL.revokeObjectURL = function revokeObjectURL(objectUrl) {
    generatedTextByUrl.delete(objectUrl);
    generatedTextPromiseByUrl.delete(objectUrl);
    return nativeRevokeObjectUrl(objectUrl);
  };

  HTMLAnchorElement.prototype.click = function click() {
    if (enabled && shouldHandleAnchor(this)) {
      postGeneratedBibtex(this.href);
      return undefined;
    }

    return nativeClick.call(this);
  };

  EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
    if (
      enabled &&
      this instanceof HTMLAnchorElement &&
      event &&
      event.type === "click" &&
      shouldHandleAnchor(this)
    ) {
      postGeneratedBibtex(this.href);
      return true;
    }

    return nativeDispatchEvent.call(this, event);
  };

  if (nativeFetch) {
    window.fetch = function fetch(input, init) {
      const requestUrl = getFetchUrl(input);
      if (!shouldInspectRequest(requestUrl)) {
        return nativeFetch(input, init);
      }

      return nativeFetch(input, init).then((response) => {
        inspectFetchResponse(requestUrl || response.url, response);
        return response;
      });
    };
  }

  XMLHttpRequest.prototype.open = function open(method, url) {
    this.__bibtexCopyRequestUrl = url ? String(url) : "";
    return nativeXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function send() {
    if (shouldInspectRequest(this.__bibtexCopyRequestUrl)) {
      this.addEventListener("loadend", () => {
        inspectXhrResponse(this);
      });
    }
    return nativeXhrSend.apply(this, arguments);
  };

  window.open = function open(url, target, features) {
    if (enabled && shouldHandleGeneratedUrl(url)) {
      postGeneratedBibtex(String(url));
      return null;
    }

    return nativeWindowOpen(url, target, features);
  };

  Location.prototype.assign = function assign(url) {
    if (enabled && shouldHandleGeneratedUrl(url)) {
      postGeneratedBibtex(String(url));
      return undefined;
    }

    return nativeLocationAssign.call(this, url);
  };

  Location.prototype.replace = function replace(url) {
    if (enabled && shouldHandleGeneratedUrl(url)) {
      postGeneratedBibtex(String(url));
      return undefined;
    }

    return nativeLocationReplace.call(this, url);
  };

  document.addEventListener("click", (event) => {
    rememberCitationIntent(event.target);

    const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!enabled || !anchor || !shouldHandleAnchor(anchor)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    postGeneratedBibtex(anchor.href);
  }, true);

  function getFetchUrl(input) {
    if (typeof input === "string") {
      return input;
    }

    if (input && typeof input.url === "string") {
      return input.url;
    }

    return "";
  }

  function inspectFetchResponse(url, response) {
    if (!enabled || !response || !shouldInspectNetworkResponse(url, response.headers && response.headers.get("content-type"))) {
      return;
    }

    response.clone().text().then((text) => {
      postNetworkBibtex(url, text);
    }).catch(() => {});
  }

  function inspectXhrResponse(xhr) {
    if (!enabled || !xhr || !shouldInspectNetworkResponse(xhr.responseURL || xhr.__bibtexCopyRequestUrl, xhr.getResponseHeader("content-type"))) {
      return;
    }

    if (xhr.responseType && !/^(?:text|json)$/i.test(xhr.responseType)) {
      return;
    }

    try {
      const text = xhr.responseType === "json" ? JSON.stringify(xhr.response) : xhr.responseText;
      postNetworkBibtex(xhr.responseURL || xhr.__bibtexCopyRequestUrl, text);
    } catch (_error) {}
  }

  function shouldInspectNetworkResponse(url, contentType) {
    return hasRecentCitationIntent() || isLikelyCitationUrl(url || "") || /(?:bibtex|x-bibtex|citation|ris|text\/plain)/i.test(contentType || "");
  }

  function shouldInspectRequest(url) {
    return enabled && (hasRecentCitationIntent() || isLikelyCitationUrl(url || ""));
  }

  function postNetworkBibtex(url, text) {
    const bibtex = extractBibtex(text);
    if (!bibtex) {
      return;
    }

    if (!hasRecentCitationIntent() && !isLikelyCitationUrl(url || "")) {
      return;
    }

    post(bibtex);
  }

  function extractBibtex(text) {
    if (!text || typeof text !== "string") {
      return "";
    }

    const value = text.trim();
    if (!value) {
      return "";
    }

    if (/^[{["]/.test(value)) {
      const jsonBibtex = extractBibtexFromJson(value);
      if (jsonBibtex) {
        return jsonBibtex;
      }
    }

    if (!BIBTEX_ENTRY_RE.test(value)) {
      return "";
    }

    return normalizeBibtex(value);
  }

  function extractBibtexFromJson(text) {
    try {
      return findBibtexInValue(JSON.parse(text));
    } catch (_error) {
      return "";
    }
  }

  function findBibtexInValue(value) {
    if (typeof value === "string") {
      return BIBTEX_ENTRY_RE.test(value) ? normalizeBibtex(value) : "";
    }

    if (Array.isArray(value)) {
      return value.map(findBibtexInValue).filter(Boolean).join("\n\n");
    }

    if (value && typeof value === "object") {
      return Object.values(value).map(findBibtexInValue).filter(Boolean).join("\n\n");
    }

    return "";
  }

  function rememberCitationIntent(target) {
    if (!target || !target.closest) {
      return;
    }

    const control = target.closest("button, a, input, label, [role='button'], [role='menuitem'], [data-testid], [aria-label], [title]");
    if (!control) {
      return;
    }

    const signal = [
      control.textContent,
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.getAttribute("value"),
      control.getAttribute("data-testid"),
      control.getAttribute("data-aa-name"),
      control.getAttribute("class"),
      control.id
    ].filter(Boolean).join(" ");

    if (/(?:bib\s*tex|export|citation|cite|download)/i.test(signal)) {
      lastCitationIntentAt = Date.now();
    }
  }

  function hasRecentCitationIntent() {
    return Date.now() - lastCitationIntentAt < 15000;
  }

  function isLikelyCitationUrl(url) {
    return /(?:bibtex|bib|citation|citations|cite|export|downloadCitation|export-citations)/i.test(url || "");
  }

  function shouldHandleAnchor(anchor) {
    const download = anchor.getAttribute("download") || "";
    const signal = download + " " + anchor.textContent + " " + anchor.href.slice(0, 180);
    if (!/(?:\.bib$|bib|bibtex|citation|cite|download)/i.test(signal)) {
      return false;
    }

    if (anchor.href.startsWith("blob:")) {
      return generatedTextByUrl.has(anchor.href) || generatedTextPromiseByUrl.has(anchor.href);
    }

    if (anchor.href.startsWith("data:")) {
      return BIBTEX_ENTRY_RE.test(decodeDataUrl(anchor.href));
    }

    return false;
  }

  function shouldHandleGeneratedUrl(url) {
    if (!url || typeof url !== "string") {
      return false;
    }

    if (url.startsWith("data:")) {
      return BIBTEX_ENTRY_RE.test(decodeDataUrl(url));
    }

    if (url.startsWith("blob:")) {
      return generatedTextByUrl.has(url) || generatedTextPromiseByUrl.has(url);
    }

    return false;
  }

  function postGeneratedBibtex(url) {
    if (url.startsWith("data:")) {
      const text = normalizeBibtex(decodeDataUrl(url));
      if (BIBTEX_ENTRY_RE.test(text)) {
        post(text);
      }
      return;
    }

    const readyText = generatedTextByUrl.get(url);
    if (readyText) {
      post(readyText);
      return;
    }

    const pendingText = generatedTextPromiseByUrl.get(url);
    if (pendingText) {
      pendingText.then((text) => {
        if (text) {
          post(text);
        }
      });
    }
  }

  function decodeDataUrl(url) {
    const commaIndex = url.indexOf(",");
    if (commaIndex < 0) {
      return "";
    }

    const metadata = url.slice(5, commaIndex);
    const payload = url.slice(commaIndex + 1);

    try {
      if (/;base64(?:;|$)/i.test(metadata)) {
        const binary = atob(payload);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder("utf-8").decode(bytes);
      }

      return decodeURIComponent(payload.replace(/\+/g, "%20"));
    } catch (_error) {
      return "";
    }
  }

  function normalizeBibtex(text) {
    const value = (text || "").trim();
    const firstEntry = value.search(BIBTEX_ENTRY_RE);
    return firstEntry > 0 ? value.slice(firstEntry).trim() : value;
  }

  function post(text) {
    window.postMessage({
      source: "bibtex-copy-page-hook",
      type: "BIBTEX_GENERATED_DOWNLOAD",
      text
    }, "*");
  }

  window.postMessage({
    source: "bibtex-copy-page-hook",
    type: "HOOK_READY"
  }, "*");
})();
