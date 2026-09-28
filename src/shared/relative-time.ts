const RELATIVE_TIME_SELECTOR = "relative-time,time-ago,local-time";

export function relativeTimeElements(scope: Document | Element = document): Element[] {
  const elements: Element[] = [];
  if (scope instanceof Element && scope.matches(RELATIVE_TIME_SELECTOR)) elements.push(scope);
  if ("querySelectorAll" in scope) {
    elements.push(...Array.from(scope.querySelectorAll(RELATIVE_TIME_SELECTOR)));
  }
  return elements;
}
