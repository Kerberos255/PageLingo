// @ts-nocheck
var ROOT_TAGS = /* @__PURE__ */ new Set([
  "P",
  "LI",
  "BLOCKQUOTE",
  "FIGCAPTION",
  "TD",
  "TH",
  "DT",
  "DD",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "SUMMARY"
]);
var SKIP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "textarea",
  "input",
  "select",
  "option",
  "button",
  "pre",
  "code",
  "kbd",
  "samp",
  "var",
  "svg",
  "math",
  "canvas",
  "video",
  "audio",
  "[contenteditable]:not([contenteditable='false'])",
  "[data-flt-generated]",
  "[hidden]",
  "[aria-hidden='true']",
  "tool-tip",
  "[role='tooltip']",
  "[inert]",
  "relative-time",
  "time-ago",
  "local-time"
].join(",");
export function isGeneratedNode(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element?.closest("[data-flt-generated]"));
}
export function isTranslationRootElement(element) {
  return ROOT_TAGS.has(element.tagName);
}
function safeDecodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function isProtectedGitHubIdentifierText(node) {
  const doc = node.ownerDocument;
  const view = doc.defaultView;
  const parent = node.parentElement;
  if (!view || !parent || view.location.hostname.toLowerCase() !== "github.com") return false;
  const text = node.data.trim();
  if (!text) return false;
  const anchor = parent.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  let target;
  try {
    target = new URL(anchor.href, view.location.href);
  } catch {
    return false;
  }
  if (target.hostname.toLowerCase() !== "github.com") return false;
  const hovercardType = anchor.getAttribute("data-hovercard-type") ?? "";
  const hovercardUrl = anchor.getAttribute("data-hovercard-url") ?? "";
  if (hovercardType === "user" || hovercardType === "organization") {
    const match = hovercardUrl.match(/^\/(?:users|orgs)\/([^/]+)\/hovercard(?:\?|$)/i);
    const hovercardName = match?.[1] ? safeDecodePathSegment(match[1]) : "";
    if (hovercardName && text === hovercardName) return true;
  }
  const targetParts = target.pathname.split("/").filter(Boolean).map(safeDecodePathSegment);
  const currentParts = view.location.pathname.split("/").filter(Boolean).map(safeDecodePathSegment);
  if (
    targetParts.length === 1 &&
    text === targetParts[0] &&
    (
      ["user", "organization"].includes(anchor.getAttribute("data-hovercard-type") ?? "") ||
      currentParts[0] === targetParts[0]
    )
  ) {
    return true;
  }
  if (
    currentParts.length >= 2 &&
    targetParts.length === 2 &&
    targetParts[0] === currentParts[0] &&
    targetParts[1] === currentParts[1] &&
    text === currentParts[1]
  ) {
    return true;
  }
  if (
    targetParts.length === 2 &&
    anchor.getAttribute("data-hovercard-type") === "repository"
  ) {
    const anchorText = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    if (
      text === targetParts[1] ||
      anchorText === targetParts[1] ||
      anchorText === `${targetParts[0]}/${targetParts[1]}`
    ) return true;
  }
  // Repository paths, branch names and file/directory names are identifiers rather
  // than prose. Translating them changes widths and can also make the visible label
  // disagree with the href. Protect labels that are a decoded suffix of a tree/blob
  // URL within the current repository.
  if (
    currentParts.length >= 2 &&
    targetParts.length >= 4 &&
    targetParts[0] === currentParts[0] &&
    targetParts[1] === currentParts[1] &&
    targetParts[2] === "commit"
  ) {
    const commitId = targetParts[3] ?? "";
    if (commitId && (commitId.startsWith(text) || text.startsWith(commitId))) return true;
  }
  if (
    currentParts.length >= 2 &&
    targetParts.length >= 4 &&
    targetParts[0] === currentParts[0] &&
    targetParts[1] === currentParts[1] &&
    (targetParts[2] === "tree" || targetParts[2] === "blob")
  ) {
    const decodedPath = target.pathname.split("/").map(safeDecodePathSegment).join("/");
    const anchorText = (anchor.textContent ?? "").replace(/\\s+/g, " ").trim();
    // GitHub may render one path label as several text nodes/spans (for example
    // ".github" + "/workflows"). Protect the whole visible path if the anchor's
    // complete label matches a suffix of its tree/blob URL, then every child text
    // node inherits that protection.
    if (anchorText && decodedPath.endsWith(`/${anchorText}`)) return true;
    if (decodedPath.endsWith(`/${text}`)) return true;
  }
  return false;
}
function isScreenReaderOnlyStyle(style) {
  const px = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  const tinyBox = px(style.width) <= 2 && px(style.height) <= 2;
  const positioned = style.position === "absolute" || style.position === "fixed";
  const overflowHidden = [style.overflow, style.overflowX, style.overflowY].some((value) => value === "hidden" || value === "clip");
  const clipped = Boolean(
    (style.clip && style.clip !== "auto" && style.clip !== "rect(auto, auto, auto, auto)") ||
    (style.clipPath && style.clipPath !== "none")
  );
  return positioned && tinyBox && (overflowHidden || clipped);
}
export function isElementEffectivelyHidden(element) {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  let current = element;
  while (current) {
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true" ||
      current.matches("tool-tip,[role='tooltip'],[inert]")
    ) return true;
    const style = view.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden" ||
      Number.parseFloat(style.opacity || "1") === 0 ||
      isScreenReaderOnlyStyle(style)
    ) return true;
    if (current === current.ownerDocument.documentElement) break;
    current = current.parentElement;
  }
  return false;
}
export function isEligibleTextNode(node) {
  if (!node.data.trim() || isProtectedGitHubIdentifierText(node)) return false;
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR) || isElementEffectivelyHidden(parent)) return false;
  // Pure counters/dates/numeric badges do not need translation and duplicating them can
  // surface otherwise hidden UI state (for example GitHub's hidden "0" tab counters).
  return /\p{L}/u.test(node.data);
}
var FALLBACK_STRUCTURAL_SELECTOR = [
  "a", "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "section",
  "article", "header", "footer", "nav", "aside", "figure", "svg", "img", "picture", "video", "canvas",
  "button", "input", "select", "textarea", "iframe"
].join(",");
function isFallbackLeafContainer(element) {
  if (!["DIV", "SPAN", "LABEL"].includes(element.tagName)) return false;
  if (element.closest(SKIP_SELECTOR)) return false;
  if (element.tagName === "DIV" && element.children.length > 0) return false;
  if (element.querySelector(FALLBACK_STRUCTURAL_SELECTOR)) return false;
  return Boolean((element.textContent ?? "").trim());
}
var STRUCTURAL_LINK_SELECTOR = [
  "svg", "img", "picture", "video", "canvas", "iframe", "button", "input", "select", "textarea",
  "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "section",
  "article", "header", "footer", "nav", "aside", "figure"
].join(",");
function isSimpleInlineContainer(element) {
  if (element.tagName !== "A" && element.tagName !== "LABEL") return false;
  if (!isFallbackLeafContainer(element)) return false;
  if (element.querySelector(STRUCTURAL_LINK_SELECTOR)) return false;
  const descendants = Array.from(element.querySelectorAll("*"));
  if (descendants.length > 8) return false;
  if (!(element.textContent ?? "").trim()) return false;
  const view = element.ownerDocument.defaultView;
  if (!view || isElementEffectivelyHidden(element)) return false;
  const style = view.getComputedStyle(element);
  const structuralDisplays = new Set(["flex", "inline-flex", "grid", "inline-grid", "table", "inline-table", "list-item", "flow-root"]);
  if (structuralDisplays.has(style.display)) return false;
  for (const child of descendants) {
    const childDisplay = view.getComputedStyle(child).display;
    if (["block", "flex", "inline-flex", "grid", "inline-grid", "table", "list-item", "flow-root"].includes(childDisplay)) return false;
  }
  if (style.display === "block") {
    const px = (value) => Number.parseFloat(value) || 0;
    const borderWidth = px(style.borderTopWidth) + px(style.borderRightWidth) + px(style.borderBottomWidth) + px(style.borderLeftWidth);
    const padding = px(style.paddingTop) + px(style.paddingRight) + px(style.paddingBottom) + px(style.paddingLeft);
    const background = style.backgroundColor;
    const hasBackground = Boolean(background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)");
    const hasBoxDecoration = borderWidth > 0 || padding > 6 || hasBackground || (style.boxShadow && style.boxShadow !== "none");
    if (hasBoxDecoration || descendants.length > 2) return false;
  }
  return true;
}
function isInsideCodeWidgetFallback(element) {
    let current = element.parentElement;
    for (let depth = 0; current && current !== current.ownerDocument.body && depth < 4; depth += 1) {
        if (current.matches("pre,code,kbd,samp,var")) return true;
        // Only treat a compact wrapper with its own direct <pre> as a code widget.
        // The old descendant search (:scope > div > pre / div > div > pre) made an
        // entire article look like a code widget whenever any sibling code block existed.
        const directPre = current.querySelector(":scope > pre");
        if (directPre && current.children.length <= 8) return true;
        if (isTranslationRootElement(current)) return false;
        current = current.parentElement;
    }
    return false;
}
export function findTranslationRoot(node) {
  let current = node.parentElement;
  let fallback = null;
  while (current && current !== current.ownerDocument.body) {
    if (current.matches(SKIP_SELECTOR)) return null;
    // Text wrappers are deliberately inserted inside structural UI (links, tabs, file
    // rows) so translating a short label never replaces the surrounding icon/badge/flex
    // container. Once we reach one, it is the authoritative translation root.
    if (current.hasAttribute("data-flt-source-text-wrapper")) return current;
    if (isTranslationRootElement(current)) {
      if (isInsideCodeWidgetFallback(current)) return null;
      if (
        fallback &&
        (
          current.querySelector("[data-flt-source-text-wrapper]") ||
          current.querySelector("svg,img,picture,canvas,[role='img']")
        )
      ) return fallback;
      return current;
    }
    if (!fallback && isFallbackLeafContainer(current)) fallback = current;
    current = current.parentElement;
  }
  if (fallback && isInsideCodeWidgetFallback(fallback)) return null;
  return fallback;
}
function wrapTextNodesInside(container, doc) {
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON", "PRE", "CODE", "KBD", "SAMP", "VAR", "SVG", "MATH", "CANVAS", "VIDEO", "AUDIO"]);
  const containers = [container, ...Array.from(container.querySelectorAll("*"))];
  for (const current of containers) {
    if (
      skipTags.has(current.tagName) ||
      current.matches?.(SKIP_SELECTOR) ||
      current.hasAttribute("data-flt-source-text-wrapper") ||
      current.closest("[data-flt-generated]")
    ) continue;
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const text = child.textContent ?? "";
      if (!text.trim() || !/\p{L}/u.test(text) || isProtectedGitHubIdentifierText(child)) continue;
      const wrapper = doc.createElement("span");
      wrapper.dataset.fltSourceTextWrapper = "true";
      child.replaceWith(wrapper);
      wrapper.append(child);
    }
  }
}
function wrapDecoratedStructuralTextNodes(scope) {
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  if (!doc || !("querySelectorAll" in scope)) return;
  const selector = "p,li,blockquote,figcaption,td,th,dt,dd,h1,h2,h3,h4,h5,h6,summary,label";
  const roots = [];
  if (scope instanceof Element && scope.matches(selector)) roots.push(scope);
  roots.push(...Array.from(scope.querySelectorAll(selector)));
  for (const root of roots) {
    if (root.closest("[data-flt-generated]") || isElementEffectivelyHidden(root)) continue;
    const structuralChild = Array.from(root.children).some((child) => {
      if (child.matches("svg,img,picture,canvas,[role='img'],input,select,textarea,button,[aria-hidden='true'],[hidden],relative-time,time-ago,local-time")) {
        return true;
      }
      const childText = (child.textContent ?? "").trim();
      if (childText && !/\p{L}/u.test(childText)) return true;
      if (!childText && (child.hasAttribute("class") || child.hasAttribute("aria-label") || child.hasAttribute("role"))) {
        return true;
      }
      return false;
    });
    const style = doc.defaultView?.getComputedStyle(root);
    const borderWidth = style
      ? ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]
          .reduce((sum, key) => sum + (Number.parseFloat(style[key]) || 0), 0)
      : 0;
    const hasBoxDecoration = Boolean(
      style && (
        borderWidth > 0 ||
        (style.boxShadow && style.boxShadow !== "none") ||
        (style.backgroundColor && style.backgroundColor !== "transparent" && style.backgroundColor !== "rgba(0, 0, 0, 0)")
      )
    );
    const mustPreserveStructure =
      root.tagName === "SUMMARY" ||
      structuralChild ||
      hasBoxDecoration ||
      Boolean(root.querySelector("svg,img,picture,canvas,[role='img'],input,select,textarea,button,relative-time,time-ago,local-time"));
    if (!mustPreserveStructure) continue;
    wrapTextNodesInside(root, doc);
  }
}
function wrapDirectAnchorTextNodes(scope) {
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  if (!doc) return;
  const anchors = [];
  if (scope instanceof Element && scope.tagName === "A") anchors.push(scope);
  if ("querySelectorAll" in scope) anchors.push(...Array.from(scope.querySelectorAll("a")));
  for (const anchor of anchors) {
    if (anchor.closest("[data-flt-generated]")) continue;
    wrapTextNodesInside(anchor, doc);
  }
}
export function collectTranslationRoots(scope) {
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  if (!doc) return [];
  wrapDirectAnchorTextNodes(scope);
  wrapDecoratedStructuralTextNodes(scope);
  const roots = /* @__PURE__ */ new Set();
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const text = current;
    if (isEligibleTextNode(text)) {
      const root = findTranslationRoot(text);
      if (root) roots.add(root);
    }
    current = walker.nextNode();
  }
  return Array.from(roots);
}
