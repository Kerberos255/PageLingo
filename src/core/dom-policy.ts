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
const TRANSLATION_CONTROLS = "button,[role='button'],[role='tab'],[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio'],[role='option'],[role='switch']";
const FIXED_ROOT_SELECTOR = [...Array.from(ROOT_TAGS, tag => tag.toLowerCase()), TRANSLATION_CONTROLS].join(",");
var SKIP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "textarea",
  "input",
  "select",
  "option",
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
  "local-time",
  "dt.sig",
  "dt.sig-object"
].join(",");
// Sphinx API declarations use dt/span/em rather than code. Translating names,
// default values or punctuation makes the displayed declaration invalid.
export function isProtectedApiSignature(element) {
  return Boolean(element?.closest?.("dt.sig,dt.sig-object"));
}
function parentAcrossShadow(element) {
  if (!element) return null;
  if (element.parentElement) return element.parentElement;
  const parent = element.parentNode;
  if (parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in parent) {
    return parent.host;
  }
  return null;
}
export function isGeneratedNode(node) {
  let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (current) {
    if (current.hasAttribute?.("data-flt-generated")) return true;
    current = parentAcrossShadow(current);
  }
  return false;
}
export function isTranslationControl(element) {
  return element.matches(TRANSLATION_CONTROLS) && !element.parentElement?.closest("p,figcaption");
}
export function isTranslationRootElement(element) {
  return ROOT_TAGS.has(element.tagName) || isTranslationControl(element);
}
export function isTranslationDisabled(element) {
  for (let current = element; current; current = parentAcrossShadow(current)) {
    const value = current.getAttribute("translate")?.toLowerCase();
    if (value === "no") return true;
    if (value === "yes" || value === "") return false;
  }
  return false;
}
export function isProtectedTranslationSubtree(element) {
  return element.tagName === "BUTTON" || element.matches(SKIP_SELECTOR);
}
function safeDecodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
const FILE_PATH_LABEL = /^(?:\.\/|\/)?(?:[\p{L}\p{N}._@+~-]+\/)*[\p{L}\p{N}._@+~-]+\.[A-Za-z][A-Za-z0-9]{0,10}$/u;

export function isProtectedFilePathLink(anchor) {
  if (!(anchor instanceof HTMLAnchorElement) || !anchor.hasAttribute("href")) return false;
  // Documentation often links a literal file path without a code element.
  // A complete label matching the target path also protects labels split across spans.
  const label = (anchor.textContent ?? "").trim();
  if (!FILE_PATH_LABEL.test(label) || (anchor.protocol !== "https:" && anchor.protocol !== "http:")) return false;
  const path = anchor.pathname.split("/").map(safeDecodePathSegment).join("/");
  return path.endsWith(`/${label.replace(/^\.?\//u, "")}`);
}

function isProtectedCodeLabelText(node) {
  const figure = node.parentElement?.closest("figcaption")?.parentElement;
  const label = figure?.getAttribute("data-code-label");
  return Boolean(label && figure.tagName === "FIGURE" && node.data.trim().toLowerCase() === label.toLowerCase() && figure.querySelector("pre"));
}

function isProtectedLinkIdentifierText(node) {
  const anchor = node.parentElement?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  const text = node.data.trim();
  if (!text) return false;
  if (isProtectedFilePathLink(anchor)) return true;

  const view = node.ownerDocument.defaultView;
  if (!view || view.location.hostname.toLowerCase() !== "github.com") return false;
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
export function isElementEffectivelyHidden(element, cache = undefined) {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  let current = element;
  const checked = cache ? [] : null;
  let hidden = false;
  while (current) {
    if (cache?.has(current)) { hidden = cache.get(current); break; }
    checked?.push(current);
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true" ||
      current.matches("tool-tip,[role='tooltip'],[inert]")
    ) { hidden = true; break; }
    const style = view.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden" ||
      Number.parseFloat(style.opacity || "1") === 0 ||
      isScreenReaderOnlyStyle(style)
    ) { hidden = true; break; }
    if (current === current.ownerDocument.documentElement) break;
    current = parentAcrossShadow(current);
  }
  for (const visited of checked ?? []) cache.set(visited, hidden);
  return hidden;
}
export function isEligibleTextContext(node, visibilityCache = undefined) {
  if (isProtectedLinkIdentifierText(node) || isProtectedCodeLabelText(node)) return false;
  const parent = node.parentElement;
  const control = parent?.closest(TRANSLATION_CONTROLS);
  return Boolean(parent && (!control || isTranslationControl(control)) && !isTranslationDisabled(parent)
    && !parent.closest(SKIP_SELECTOR) && !isElementEffectivelyHidden(parent, visibilityCache));
}
const KEY_MODIFIER_PREFIX = /^(?:(?:(?:ctrl|control|alt|opt|option|shift|cmd|command|meta|win|super)\s*[+-]\s*)+|(?:[⌘⌃⌥⇧⇑↑↓←→]\s*)+)/iu;
const UNAMBIGUOUS_KEYCAP_TOKEN = /^(?:F(?:[1-9]|1\d|2[0-4])|Esc|Ctrl|Alt|Cmd|Fn|PgUp|PgDn|PrtSc|SysRq|CapsLock|NumLock|ScrollLock)$/iu;
const STANDALONE_SHORTCUT_KEY = /^(?:[A-Za-z]|F(?:[1-9]|1\d|2[0-4])|Esc|Ctrl|Alt|Cmd|Fn|PgUp|PgDn|PrtSc|SysRq|CapsLock|NumLock|ScrollLock)$/iu;
const MODIFIED_SHORTCUT_KEY = /^(?:[A-Za-z0-9]|F(?:[1-9]|1\d|2[0-4])|Esc|Tab|Enter|Return|Space|Backspace|Delete|Del|Insert|Ins|Home|End|PageUp|PageDown|PgUp|PgDn|Up|Down|Left|Right|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/iu;

function isUnambiguousKeycapText(text) {
  if (!text || text.length > 32) return false;
  if (UNAMBIGUOUS_KEYCAP_TOKEN.test(text)) return true;
  if (KEY_MODIFIER_PREFIX.test(text)) {
    const remainder = text.replace(KEY_MODIFIER_PREFIX, "").trim();
    if (remainder && MODIFIED_SHORTCUT_KEY.test(remainder)) return true;
  }
  return false;
}

export function isStandaloneShortcutLabel(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 32) return false;
  if (STANDALONE_SHORTCUT_KEY.test(text)) return true;
  return isUnambiguousKeycapText(text);
}

export function isEligibleTextNode(node, visibilityCache = undefined) {
  const text = node.data.trim();
  if (!text || !isEligibleTextContext(node, visibilityCache)) return false;
  // Pure counters/dates/version badges and explicit keycaps (Esc, F1, Ctrl+S, ⇑Q)
  // do not need translation and translating them turns shortcuts into nonsense.
  return /\p{L}/u.test(text)
    && !/^v\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/i.test(text)
    && !isUnambiguousKeycapText(text);
}
var FALLBACK_CONTAINER_TAGS = new Set([
  "DIV", "SPAN", "LABEL", "STRONG", "B", "EM", "I", "U", "S", "SMALL", "MARK", "Q", "CITE", "ABBR", "DEL", "INS"
]);
var MIXED_CONTAINER_TAGS = new Set([
  "DIV", "SPAN", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV", "FIGURE", "FORM", "FIELDSET"
]);
var INLINE_PROSE_TAGS = new Set([
  "SPAN", "STRONG", "EM", "B", "I", "U", "S", "SMALL", "SUB", "SUP", "MARK", "ABBR", "CITE", "Q", "DEL", "INS", "A", "LABEL"
]);
var NON_STRUCTURAL_BLOCK_BOUNDARY_TAGS = new Set([
  "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "NAV", "ASIDE",
  "FIGURE", "UL", "OL", "DL", "TABLE", "FORM", "FIELDSET", "DETAILS",
  "DIALOG", "HR", "IMG", "PICTURE"
]);

export function isNestedOwnerBoundary(element, root) {
  if (!element || element === root) return false;
  if (isTranslationRootElement(element)) return true;
  if (root && !isTranslationRootElement(root) && NON_STRUCTURAL_BLOCK_BOUNDARY_TAGS.has(element.tagName)) {
    return true;
  }
  return false;
}

export function hasNestedOwnerBoundaryBetween(descendant, root) {
  for (let current = descendant; current && current !== root; current = current.parentElement) {
    if (isNestedOwnerBoundary(current, root)) return true;
  }
  return false;
}

var FALLBACK_STRUCTURAL_SELECTOR = [
  "a", "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "section",
  "article", "header", "footer", "nav", "aside", "figure", "svg", "img", "picture", "video", "canvas",
  "button", "input", "select", "textarea", "iframe"
].join(",");
const EXCLUDED_CUSTOM_TAGS = new Set(["RELATIVE-TIME", "TIME-AGO", "LOCAL-TIME", "TOOL-TIP"]);
function isCustomProseContainer(element) {
  return Boolean(element?.tagName?.includes("-")) && !EXCLUDED_CUSTOM_TAGS.has(element.tagName);
}
function isFallbackLeafContainer(element) {
  if (!FALLBACK_CONTAINER_TAGS.has(element.tagName) && !isCustomProseContainer(element)) return false;
  if (element.closest(SKIP_SELECTOR) || element.closest("button")) return false;
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
function isDirectCodeWidgetContainer(element) {
  if (!element || element === element.ownerDocument.body) return false;
  if (element.matches("pre,code,kbd,samp,var")) return true;
  if (isTranslationRootElement(element)) return false;
  const directPre = element.querySelector(":scope > pre");
  if (!directPre || element.children.length > 8) return false;
  // A prose container (such as a rendered Markdown message) holding semantic paragraphs
  // or headings alongside a <pre> block is prose with code examples, not a code widget.
  if (element.querySelector(":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > blockquote, :scope > ul, :scope > ol")) {
    return false;
  }
  return true;
}
function isInsideCodeWidgetFallback(element) {
    if (isDirectCodeWidgetContainer(element)) return true;
    let current = element.parentElement;
    for (let depth = 0; current && current !== current.ownerDocument.body && depth < 4; depth += 1) {
        if (current.matches("pre,code,kbd,samp,var")) return true;
        // A list item or blockquote can contain both prose and a code example.
        // Its structural boundary owns the prose before code-widget heuristics.
        if (isTranslationRootElement(current)) return false;
        // Only treat a compact wrapper with its own direct <pre> as a code widget.
        // The old descendant search (:scope > div > pre / div > div > pre) made an
        // entire article look like a code widget whenever any sibling code block existed.
        if (isDirectCodeWidgetContainer(current)) return true;
        current = current.parentElement;
    }
    return false;
}
function hasDirectEligibleText(element, visibilityCache = undefined) {
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && isEligibleTextNode(child, visibilityCache)) return true;
  }
  return false;
}
function findMixedContainerRoot(node, doc) {
  let current = node.parentElement;
  while (current && current !== doc.body && current !== doc.documentElement) {
    if (isProtectedTranslationSubtree(current) || isTranslationRootElement(current)) return null;
    if (isInsideCodeWidgetFallback(current)) return null;
    if (MIXED_CONTAINER_TAGS.has(current.tagName) || isCustomProseContainer(current)) return current;
    if (!INLINE_PROSE_TAGS.has(current.tagName)) return null;
    current = current.parentElement;
  }
  return null;
}
function promoteInlineOwner(root, doc, visibilityCache = undefined) {
  if (!root || isTranslationRootElement(root) || NON_STRUCTURAL_BLOCK_BOUNDARY_TAGS.has(root.tagName)) {
    return root;
  }
  let owner = root;
  for (let current = root.parentElement; current && current !== doc.body && current !== doc.documentElement; current = current.parentElement) {
    if (isProtectedTranslationSubtree(current) || isTranslationRootElement(current)) break;
    if (isInsideCodeWidgetFallback(current)) break;
    const isBlockBoundary = NON_STRUCTURAL_BLOCK_BOUNDARY_TAGS.has(current.tagName);
    if (current.matches("a,label")) {
      owner = current;
      continue;
    }
    if ((MIXED_CONTAINER_TAGS.has(current.tagName) || FALLBACK_CONTAINER_TAGS.has(current.tagName) || isCustomProseContainer(current))
      && hasDirectEligibleText(current, visibilityCache)) {
      owner = current;
    }
    if (isBlockBoundary) break;
  }
  return owner;
}
function ownedTextSummary(root, excludeNestedRoots = false) {
  let text = "";
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const parent = current.parentElement;
    if (!parent || parent.closest(SKIP_SELECTOR)) continue;
    if (excludeNestedRoots && hasNestedOwnerBoundaryBetween(parent, root)) continue;
    text += current.data;
  }
  return text;
}
export function findTranslationRoot(node) {
  let current = node.parentElement;
  let fallback = null;
  while (current && current !== current.ownerDocument.body) {
    if (isProtectedTranslationSubtree(current)) return null;
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
  if (isProtectedApiSignature(container)) return;
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON", "PRE", "CODE", "KBD", "SAMP", "VAR", "SVG", "MATH", "CANVAS", "VIDEO", "AUDIO"]);
  const containers = [container, ...Array.from(container.querySelectorAll("*"))];
  for (const current of containers) {
    if (
      skipTags.has(current.tagName) ||
      current.matches?.(SKIP_SELECTOR) ||
      current.hasAttribute("data-flt-source-text-wrapper") ||
      current.closest("button,[data-flt-generated]")
    ) continue;
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const text = child.textContent ?? "";
      if (!text.trim() || !/\p{L}/u.test(text) || isProtectedLinkIdentifierText(child) || isProtectedCodeLabelText(child)) continue;
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
    if (isProtectedApiSignature(root) || root.closest("[data-flt-generated]") || isElementEffectivelyHidden(root)) continue;
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
export function collectTranslationRoots(scope, { preserveInlineContext = false, onHidden = undefined, onShadowRoot = undefined } = {}) {
  const doc = scope instanceof Document ? scope : scope.ownerDocument;
  if (!doc) return [];
  if (preserveInlineContext) {
    // Fixed text rendering needs no source wrappers, including inside toolbars or anchors.
    const roots = new Set();
    const visibility = new WeakMap();
    if (scope instanceof Element) {
      if (isElementEffectivelyHidden(scope, visibility)) {
        onHidden?.(scope);
        return [];
      }
      if (scope.matches(SKIP_SELECTOR)) return [];
    }
    const scopes = [scope];
    const seenShadows = new Set();
    if (scope instanceof Element && scope.shadowRoot && !seenShadows.has(scope.shadowRoot)) {
      seenShadows.add(scope.shadowRoot);
      onShadowRoot?.(scope.shadowRoot);
      scopes.push(scope.shadowRoot);
    }
    while (scopes.length) {
      const currentScope = scopes.shift();
      const walker = doc.createTreeWalker(currentScope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, node => {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (isElementEffectivelyHidden(node, visibility)) { onHidden?.(node); return NodeFilter.FILTER_REJECT; }
        if (node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (node.shadowRoot && !seenShadows.has(node.shadowRoot)) {
          seenShadows.add(node.shadowRoot);
          onShadowRoot?.(node.shadowRoot);
          scopes.push(node.shadowRoot);
        }
        return NodeFilter.FILTER_SKIP;
      });
      let node;
      while ((node = walker.nextNode())) {
        if (!isEligibleTextNode(node, visibility)) continue;
        // The fixed renderer keeps controls/icons in place, so an inline fallback
        // inside a paragraph must not become a second, overlapping translation root.
        const structural = node.parentElement?.closest(FIXED_ROOT_SELECTOR);
        let root = null;
        if (structural) {
          root = !isInsideCodeWidgetFallback(structural) ? structural : null;
        } else {
          root = findTranslationRoot(node)
            ?? node.parentElement?.closest("a,label")
            ?? findMixedContainerRoot(node, doc);
          if (root) root = promoteInlineOwner(root, doc, visibility);
        }
        if (root) roots.add(root);
      }
    }
    // A fallback container may own both direct text and nested inline elements.
    // Keep the selected outer owner so concurrent translations cannot invalidate
    // each other's source, while preserving independent structural roots and
    // nested block boundaries.
    for (const root of roots) {
      if (isTranslationRootElement(root)) continue;
      for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (roots.has(ancestor) && !hasNestedOwnerBoundaryBetween(root, ancestor)) {
          roots.delete(root);
          break;
        }
      }
    }
    // Skip standalone single-letter / keycap shortcut badges (e.g. Q, W, Esc, F1)
    // without excluding single-letter words inside prose sentences.
    for (const root of roots) {
      if (isStandaloneShortcutLabel(ownedTextSummary(root, true))) {
        roots.delete(root);
      }
    }
    return Array.from(roots);
  }
  const roots = /* @__PURE__ */ new Set();
  const seenShadows = new Set();
  const scopes = [scope];
  if (scope instanceof Element && !scope.matches(SKIP_SELECTOR) && !isElementEffectivelyHidden(scope) && scope.shadowRoot) {
    seenShadows.add(scope.shadowRoot);
    onShadowRoot?.(scope.shadowRoot);
    scopes.push(scope.shadowRoot);
  }
  while (scopes.length) {
    const currentScope = scopes.shift();
    wrapDirectAnchorTextNodes(currentScope);
    wrapDecoratedStructuralTextNodes(currentScope);
    const walker = doc.createTreeWalker(currentScope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, node => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node.matches(SKIP_SELECTOR) || isElementEffectivelyHidden(node)) return NodeFilter.FILTER_REJECT;
      if (node.shadowRoot && !seenShadows.has(node.shadowRoot)) {
        seenShadows.add(node.shadowRoot);
        onShadowRoot?.(node.shadowRoot);
        scopes.push(node.shadowRoot);
      }
      return NodeFilter.FILTER_SKIP;
    });
    let current = walker.nextNode();
    while (current) {
      const text = current;
      if (isEligibleTextNode(text)) {
        const root = findTranslationRoot(text);
        if (root) roots.add(root);
      }
      current = walker.nextNode();
    }
  }
  for (const root of roots) {
    if (isStandaloneShortcutLabel(ownedTextSummary(root, false))) {
      roots.delete(root);
    }
  }
  return Array.from(roots);
}
