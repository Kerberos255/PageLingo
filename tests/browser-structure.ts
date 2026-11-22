// Deterministic production rendering regressions in a real browser; no model calls.
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationRequest } from "../src/core/provider";

export async function runBrowserStructureRegressions() {
  const rows: Array<{ id: string; passed: boolean; calls: number }> = [];
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const provider = () => {
    const requests: TranslationRequest[] = [];
    return {
      requests,
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (request: TranslationRequest) => {
        requests.push(request);
        const body = new DOMParser().parseFromString(request.html, "text/html").body;
        for (const slot of body.querySelectorAll("[data-flt-text-id]")) slot.textContent = `第${requests.length}次译文`;
        return body.innerHTML;
      },
    };
  };
  const fixture = (html: string) => { document.body.innerHTML = html; };

  fixture("<p>Hello world.</p>");
  const observed = provider(), observing = new PageTranslator(document, observed, {
    displayMode: "translation",
    shouldTranslateRoot: (root: HTMLElement) => !/[\u3400-\u9fff]/u.test(root.textContent ?? ""),
  });
  try {
    observing.observe();
    await observing.translateAll();
    await new Promise(resolve => setTimeout(resolve, 100));
    check(observed.requests.length === 1 && observing.translatedCount === 1, "Own text mutations caused a translation/restoration cycle");
    rows.push({ id: "observed-language-eligibility", passed: true, calls: observed.requests.length });
  } finally {
    observing.restore();
  }
  check(document.querySelector("p")!.textContent === "Hello world.", "Observed source was not restored");

  for (const subtree of [false, true]) {
    fixture('<p id="from"><em>Original text.</em></p><p id="to"></p>');
    const fake = provider(), translator = new PageTranslator(document, fake, { displayMode: "translation" });
    const moved = subtree ? document.querySelector("em")! : document.querySelector("em")!.firstChild!;
    try {
      await translator.translateAll();
      document.querySelector("#to")!.append(moved);
      await translator.translateAll(document.querySelector("#to")!);
      check(fake.requests.length === 2 && fake.requests[1]!.html.includes("Original text."), "Moved text was retranslated from Chinese");
      rows.push({ id: subtree ? "move-subtree-to-new-root" : "move-text-to-new-root", passed: true, calls: fake.requests.length });
    } finally {
      translator.restore();
    }
    check(document.querySelector("#to")!.textContent === "Original text.", "Moved source was lost");
  }

  fixture("<p>Original text.</p>");
  const changed = provider(), changing = new PageTranslator(document, changed, { displayMode: "translation" });
  await changing.translateAll();
  const original = document.querySelector("p")!.firstChild!, wrapper = document.createElement("span");
  document.querySelector("p")!.append(wrapper);
  wrapper.append(original);
  original.textContent = "Website replacement.";
  changing.restore();
  check(original.textContent === "Website replacement.", "Restore overwrote website replacement");
  rows.push({ id: "moved-website-edit-wins", passed: true, calls: changed.requests.length });

  for (const displayMode of ["translation", "bilingual"] as const) {
    fixture('<nav><a href="/guide"><span>Read</span> more</a></nav>');
    const before = document.body.innerHTML, fake = provider(), translator = new PageTranslator(document, fake, { displayMode });
    try {
      await translator.translateAll();
      check(fake.requests.length === 1 && translator.translatedCount === 1, "Overlapping standalone link roots");
      rows.push({ id: `standalone-link-${displayMode}`, passed: true, calls: fake.requests.length });
    } finally {
      translator.restore();
    }
    check(document.body.innerHTML === before, "Standalone link restore mismatch");
  }

  for (const deep of [false, true]) {
    for (const displayMode of ["translation", "bilingual"] as const) {
      fixture(`<div><span id="owner">${deep ? "<strong><span>Read</span> the</strong> guide" : "<span>Read</span> more"}</span><p>Independent paragraph.</p></div>`);
      const before = document.body.innerHTML, owner = document.querySelector("#owner")!;
      const originalNodes = [owner, ...owner.querySelectorAll("*")].map(node => ({
        node,
        children: [...node.childNodes],
        attrs: JSON.stringify([...node.attributes].map(a => [a.name, a.value])),
      }));
      const fake = provider(), translator = new PageTranslator(document, fake, { displayMode, concurrency: 2 });
      try {
        await translator.translateAll();
        check(fake.requests.length === 2 && translator.translatedCount === 2, "Overlapping nested fallback span roots");
        check(fake.requests[0]!.html.includes("Read") && fake.requests[0]!.html.includes(deep ? " guide" : " more"), "Outer span lost part of its source");
        check(originalNodes.every(item => item.node.isConnected
          && item.attrs === JSON.stringify([...item.node.attributes].map(a => [a.name, a.value]))
          && item.children.length === item.node.childNodes.length
          && item.children.every((child, index) => child === item.node.childNodes[index])), "Nested span original DOM changed");
        rows.push({ id: `fallback-span-${deep ? "deep" : "simple"}-${displayMode}`, passed: true, calls: fake.requests.length });
      } finally {
        translator.restore();
      }
      check(document.body.innerHTML === before, "Nested span exact restore mismatch");
    }
  }

  return {
    scope: "Deterministic production original-node structure regression checks.",
    rows,
  };
}
