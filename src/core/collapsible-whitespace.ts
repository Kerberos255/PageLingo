import {isEligibleTextContext, isEligibleTextNode} from "./dom-policy";
import {classifyProsePunctuation} from "./prose-punctuation";

export const isAsciiWhitespace = (text: string) => /^[ \t\r\n\f]+$/u.test(text);
export const isAsciiWhitespaceOrEmpty = (text: string) => /^[ \t\r\n\f]*$/u.test(text);

// CSS normal/nowrap collapse ASCII whitespace. NBSP and pre-line line breaks
// are different contracts and never become optional through this policy.
export function canCollapseProseWhitespace(node: Text): boolean {
  if (!node.parentElement || !isEligibleTextContext(node)) return false;
  const style = node.ownerDocument.defaultView?.getComputedStyle(node.parentElement);
  return Boolean(style && ["normal", "nowrap"].includes(style.whiteSpace || "normal")
    && (!style.whiteSpaceCollapse || style.whiteSpaceCollapse === "collapse"));
}

export function canWriteFrozenProseGap(node: Text, source: string): boolean {
  if (!canCollapseProseWhitespace(node)) return false;
  return Boolean(/\p{L}/u.test(source) && isEligibleTextNode(node) || isAsciiWhitespace(source)
    || classifyProsePunctuation(source, "prose", "", {collapsibleWhitespace: true}));
}
