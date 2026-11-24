import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function loadHtmlIntoDocument(relativePath: string): void {
  const html = readFileSync(resolve(process.cwd(), relativePath), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("settings & popup switch click targets", () => {
  it("keeps every checkbox/switch in settings.html strictly scoped to the switch control, not row text", () => {
    loadHtmlIntoDocument("public/settings.html");
    const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes.length).toBeGreaterThanOrEqual(12);

    for (const input of checkboxes) {
      input.disabled = false;
      const before = input.checked;

      // Must NOT be wrapped in a row-level <label> containing descriptive copy.
      const enclosingLabel = input.closest("label");
      if (enclosingLabel) {
        expect(enclosingLabel.classList.contains("switch")).toBe(true);
        expect(enclosingLabel.textContent?.trim() ?? "").toBe("");
      }

      // Clicking the enclosing row container or its text elements must NOT toggle the checkbox.
      const row = input.closest<HTMLElement>(".setting-row, .engine-checkbox, .glossary-card-top");
      expect(row).not.toBeNull();
      const textTargets = Array.from(row!.querySelectorAll<HTMLElement>("strong, small, span")).filter(
        (el) => !el.closest(".switch") && (el.textContent?.trim().length ?? 0) > 0,
      );
      expect(textTargets.length).toBeGreaterThan(0);

      for (const textEl of textTargets) {
        textEl.click();
        expect(input.checked).toBe(before);
      }

      // Clicking the switch control itself MUST toggle the checkbox.
      const clickTarget = enclosingLabel ?? input;
      clickTarget.click();
      expect(input.checked).toBe(!before);

      // Accessibility: every checkbox must have aria-label or valid aria-labelledby.
      const ariaLabel = input.getAttribute("aria-label")?.trim();
      const labelledBy = input.getAttribute("aria-labelledby")?.trim();
      const labelNode = labelledBy ? document.getElementById(labelledBy) : null;
      expect(Boolean(ariaLabel || labelNode?.textContent?.trim())).toBe(true);
    }
  });

  it("keeps the popup site-auto switch strictly scoped to the switch control, not row text", () => {
    loadHtmlIntoDocument("public/popup.html");
    const siteAuto = document.querySelector<HTMLInputElement>("#site-auto")!;
    expect(siteAuto).not.toBeNull();
    siteAuto.disabled = false;

    const row = siteAuto.closest<HTMLElement>(".site-auto-row")!;
    expect(row.tagName).toBe("DIV");

    const title = row.querySelector<HTMLElement>("strong")!;
    const hint = row.querySelector<HTMLElement>("small")!;
    const switchLabel = siteAuto.closest<HTMLLabelElement>("label.switch")!;
    expect(switchLabel).not.toBeNull();
    expect(switchLabel.textContent?.trim() ?? "").toBe("");

    const before = siteAuto.checked;
    title.click();
    hint.click();
    row.click();
    expect(siteAuto.checked).toBe(before);

    switchLabel.click();
    expect(siteAuto.checked).toBe(!before);

    const labelledBy = siteAuto.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelledBy)?.textContent?.trim()).toBe("在此网站自动翻译");
  });
});
