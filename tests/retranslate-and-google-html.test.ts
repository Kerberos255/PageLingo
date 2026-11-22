import { afterEach, describe, expect, it } from "vitest";
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationRequest } from "../src/core/provider";
import { packGoogleFreeHtml, unpackGoogleFreeHtml } from "../src/providers/google-free-html";

afterEach(() => {
  document.body.replaceChildren();
});

describe("forced retranslation and single-segment retranslate", () => {
  it("supports one-shot full-page bypassCache and right-click single-segment retranslation in both translation and bilingual modes", async () => {
    document.body.innerHTML = `
      <main>
        <p id="p1">First paragraph text.</p>
        <p id="p2">Second paragraph text.</p>
      </main>
    `;
    const calls: TranslationRequest[] = [];
    let version = 1;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (req: TranslationRequest) => {
        calls.push(req);
        return req.html
          .replace("First paragraph text.", `第一段译文 v${version}`)
          .replace("Second paragraph text.", `第二段译文 v${version}`);
      },
    };

    // Full-page forced pass sends bypassCache: true for initial roots.
    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "translation",
      bypassCache: true,
    });
    await translator.translateAll(document.body);
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.bypassCache === true)).toBe(true);
    expect(document.getElementById("p1")!.textContent).toBe("第一段译文 v1");
    expect(document.getElementById("p2")!.textContent).toBe("第二段译文 v1");

    // Dynamic root translated afterwards should NOT force bypassCache.
    const p3 = document.createElement("p");
    p3.textContent = "Third paragraph text.";
    document.querySelector("main")!.append(p3);
    await translator.translateRoot(p3);
    expect(calls.at(-1)?.bypassCache).toBeUndefined();

    // Right-clicking p1 locates p1 and retranslates ONLY p1 with bypassCache: true.
    version = 2;
    const p1 = document.getElementById("p1")!;
    expect(translator.findTranslatedRootForNode(p1.firstChild)).toBe(p1);
    const ok = await translator.retranslateRoot(p1, { bypassCache: true });
    expect(ok).toBe(true);
    expect(calls.at(-1)?.bypassCache).toBe(true);
    expect(p1.textContent).toBe("第一段译文 v2");
    expect(document.getElementById("p2")!.textContent).toBe("第二段译文 v1");

    // In bilingual mode, right-clicking directly on the generated translation block maps back to its source root.
    translator.setDisplayMode("bilingual");
    const generated = document.querySelector('[data-flt-generated="translation"]')!;
    expect(translator.findTranslatedRootForNode(generated)).toBe(p1);
    version = 3;
    await translator.retranslateRoot(p1, { bypassCache: true });
    expect(document.querySelector('[data-flt-generated="translation"]')!.textContent).toBe("第一段译文 v3");

    translator.restore();
  });
});

describe("Google Free whole-paragraph compact HTML transport", () => {
  it("packs and unpacks rich inline formatting, code atoms, and glossary terms losslessly", () => {
    const sourceHtml =
      '<span data-flt-text-id="0">Onboarding offers </span>' +
      '<strong><span data-flt-text-id="1">Quick start</span></strong>' +
      '<span data-flt-text-id="2"> and </span>' +
      '<strong><span data-flt-text-id="3">Custom setup</span></strong>' +
      '<span data-flt-text-id="4">. </span>' +
      '<code>openclaw onboard --classic</code>' +
      '<span data-flt-text-id="5"> opens the wizard in <span data-flt-term-id="0">Firefox</span>.</span>';

    const plan = packGoogleFreeHtml(sourceHtml);
    expect(plan).not.toBeNull();
    expect(plan?.wireHtml).toBe(
      'Onboarding offers <b data-pl-el="0">Quick start</b> and <b data-pl-el="1">Custom setup</b>. ' +
      '<span class="notranslate" data-pl-a="0">openclaw onboard --classic</span> opens the wizard in <span class="notranslate" data-pl-t="0">Firefox</span>.',
    );

    const wireTranslated =
      '新手入门提供 <b data-pl-el="0">快速启动</b> 和 <b data-pl-el="1">自定义设置</b>。' +
      '<span class="notranslate" data-pl-a="0">openclaw onboard --classic</span> 在 <span class="notranslate" data-pl-t="0">Firefox</span> 中打开向导。';

    const unpacked = unpackGoogleFreeHtml(plan!, wireTranslated);
    expect(unpacked).toBe(
      '<span data-flt-text-id="0">新手入门提供 </span>' +
      '<strong><span data-flt-text-id="1">快速启动</span></strong>' +
      '<span data-flt-text-id="2"> 和 </span>' +
      '<strong><span data-flt-text-id="3">自定义设置</span></strong>' +
      '<span data-flt-text-id="4">。 </span>' +
      '<code>openclaw onboard --classic</code>' +
      '<span data-flt-text-id="5"> 在 <span data-flt-term-id="0">Firefox</span> 中打开向导。</span>',
    );
  });

  it("rejects reordered tags so caller safely falls back to plain-text slots", () => {
    const sourceHtml =
      '<span data-flt-text-id="0">Use </span>' +
      '<strong><span data-flt-text-id="1">A</span></strong>' +
      '<span data-flt-text-id="2"> before </span>' +
      '<em><span data-flt-text-id="3">B</span></em>';
    const plan = packGoogleFreeHtml(sourceHtml)!;
    const reordered = '在 <i data-pl-el="1">B</i> 之前使用 <b data-pl-el="0">A</b>';
    expect(unpackGoogleFreeHtml(plan, reordered)).toBeUndefined();
  });
});
