import { afterEach, describe, expect, it, vi } from "vitest";
import { collectTranslationRoots, isStandaloneShortcutLabel } from "../src/core/dom-policy";
import { PageTranslator } from "../src/core/page-translator";
import { sourceFingerprint } from "../src/core/rich-segment";
import { planPreformattedParagraphRuns } from "../src/core/fixed-html-paragraphs";
import {
  resetExternalTranslationStateForTests,
  translateWithExternalEngine,
} from "../src/providers/external-translation";
import {
  BUILTIN_GOOGLE_ENGINE_ID,
  BUILTIN_MICROSOFT_ENGINE_ID,
  builtinFreeEngineConfig,
} from "../src/shared/translation-engine-settings";
import { sourceTextSample } from "../src/shared/source-text-sample";
import type { TranslationRequest } from "../src/core/provider";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  resetExternalTranslationStateForTests();
});

function whitespaceCollapsingProvider() {
  const requests: TranslationRequest[] = [];
  return {
    requests,
    prefersWholeSentenceHtml: async () => true,
    translateHtml: async (request: TranslationRequest) => {
      requests.push(request);
      const body = new DOMParser().parseFromString(request.html, "text/html").body;
      for (const slot of body.querySelectorAll("span[data-flt-text-id]")) {
        const raw = slot.textContent ?? "";
        const leading = raw.match(/^\s*/u)?.[0] ?? "";
        const trailing = raw.match(/\s*$/u)?.[0] ?? "";
        // Intentionally collapse internal whitespace (like Bergamot HTML mode)
        // to prove multi-paragraph pre-wrap breaks are preserved by the splitter.
        const collapsed = raw.trim().replace(/\s+/gu, " ");
        slot.textContent = `${leading}译:${collapsed}${trailing}`;
      }
      return body.innerHTML;
    },
  };
}

describe("mixed inline/block prose containers and preformatted paragraphs", () => {
  it.each(["translation", "bilingual"] as const)(
    "translates mixed pre-wrap story container with h1, i, multi-paragraph direct text, and b without losing paragraph breaks: %s",
    async (displayMode) => {
      document.body.innerHTML =
        '<div id="mainText"><span class="mainText" style="white-space: pre-wrap">' +
        '<h1 class="codexBlockHeader">The Past</h1>' +
        "<i>... Approximately Twenty Years Ago ...</i>\n\n" +
        "Victor Steele is one of the richest men in the galaxy.\n\n" +
        "Unfortunately, during his adventures, Victor underwent many mutations.\n\n" +
        "***\n\n" +
        "The real question is, who should the mother be?\n\n" +
        "<b>What species would you like your character to be?</b>" +
        "</span></div>";

      const before = document.body.innerHTML;
      const h1 = document.querySelector("h1")!;
      const mainText = document.querySelector<HTMLElement>(".mainText")!;
      const italic = mainText.querySelector("i")!;
      const bold = mainText.querySelector("b")!;
      const directTextNode = italic.nextSibling as Text;
      expect(directTextNode.nodeType).toBe(Node.TEXT_NODE);

      const roots = collectTranslationRoots(document.body, { preserveInlineContext: true });
      expect(roots).toEqual([h1, mainText]);

      const provider = whitespaceCollapsingProvider();
      const translator = new PageTranslator(document, provider, {
        displayMode,
        sourceLanguage: "en",
        targetLanguage: "zh-Hans",
        shouldTranslateRoot: (root: HTMLElement) => {
          const owned = sourceFingerprint(root, { excludeNestedRoots: true });
          return !/[\u3400-\u9fff]/u.test(owned);
        },
      });

      await translator.translateAll();
      expect(translator.failedCount).toBe(0);
      expect(translator.translatedCount).toBe(2);

      if (displayMode === "translation") {
        expect(h1.textContent).toBe("译:The Past");
        expect(italic.textContent).toBe("译:... Approximately Twenty Years Ago ...");
        expect(bold.textContent).toBe("译:What species would you like your character to be?");
        expect(directTextNode.data).toBe(
          "\n\n译:Victor Steele is one of the richest men in the galaxy.\n\n" +
          "译:Unfortunately, during his adventures, Victor underwent many mutations.\n\n" +
          "***\n\n" +
          "译:The real question is, who should the mother be?\n\n",
        );
        // Exact original element & Text node identities preserved
        expect(mainText.querySelector("h1")).toBe(h1);
        expect(mainText.querySelector("i")).toBe(italic);
        expect(mainText.querySelector("b")).toBe(bold);
        expect(italic.nextSibling).toBe(directTextNode);
      } else {
        const mounted = mainText.nextElementSibling as HTMLElement;
        expect(mounted?.dataset.fltGenerated).toBe("translation");
        expect(mounted.querySelector("h1")).toBeNull();
        expect(mounted.textContent).toContain("译:Victor Steele is one of the richest men in the galaxy.");
        expect(mounted.textContent).toContain("译:The real question is, who should the mother be?");
      }

      translator.restore();
      expect(document.body.innerHTML).toBe(before);
    },
  );

  it("keeps inline dialogue on the same preformatted paragraph together while splitting blank-line paragraphs", () => {
    const sourceHtml =
      '<span data-flt-text-id="0">Victor approaches the clinic.\n\nEntering the room, </span>' +
      '<i><span data-flt-text-id="1">“So, Victor?”</span></i>' +
      '<span data-flt-text-id="2"> the doctor asks, </span>' +
      '<i><span data-flt-text-id="3">“Ready?”</span></i>' +
      "\n\n" +
      '<b><span data-flt-text-id="4">Choose gender</span></b>';

    const plan = planPreformattedParagraphRuns(sourceHtml);
    expect(plan).not.toBeNull();
    expect(plan!.runs).toHaveLength(3);
    expect(plan!.runs[0]!.html).toBe('<span data-flt-text-id="0">Victor approaches the clinic.</span>');
    expect(plan!.runs[1]!.html).toBe(
      '<span data-flt-text-id="0">Entering the room, </span>' +
      '<i><span data-flt-text-id="1">“So, Victor?”</span></i>' +
      '<span data-flt-text-id="2"> the doctor asks, </span>' +
      '<i><span data-flt-text-id="3">“Ready?”</span></i>',
    );
    expect(plan!.runs[2]!.html).toBe('<b><span data-flt-text-id="0">Choose gender</span></b>');

    const reassembled = plan!.reassemble([
      '<span data-flt-text-id="0">维克多走近诊所。</span>',
      '<span data-flt-text-id="0">走进房间，</span>' +
      '<i><span data-flt-text-id="1">“那么，维克多？”</span></i>' +
      '<span data-flt-text-id="2"> 医生问道，</span>' +
      '<i><span data-flt-text-id="3">“准备好了吗？”</span></i>',
      '<b><span data-flt-text-id="0">选择性别</span></b>',
    ]);
    expect(reassembled).toContain("维克多走近诊所。\n\n走进房间，");
    expect(reassembled).toContain("<i><span data-flt-text-id=\"1\">“那么，维克多？”</span></i>");
    expect(reassembled).toContain("<b><span data-flt-text-id=\"4\">选择性别</span></b>");
  });

  it("stops a mixed non-structural root at nested block boundaries and never duplicates embedded graphics in bilingual mode", async () => {
    document.body.innerHTML =
      '<span class="mainText" style="white-space: pre-wrap">' +
      "<h1>Human</h1>" +
      "A purely human heritage gives a familiar body." +
      '<div class="creation mom_graphic"><img alt="portrait"><span>Mother portrait</span></div>' +
      "</span>";

    const before = document.body.innerHTML;
    const h1 = document.querySelector("h1")!;
    const mainText = document.querySelector<HTMLElement>(".mainText")!;
    const caption = document.querySelector(".mom_graphic span")!;

    const roots = collectTranslationRoots(document.body, { preserveInlineContext: true });
    expect(roots).toEqual([h1, mainText, caption]);

    const provider = whitespaceCollapsingProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "bilingual" });
    await translator.translateAll();

    expect(translator.translatedCount).toBe(3);
    expect(translator.failedCount).toBe(0);
    // The embedded graphic div inside .mainText must NOT be duplicated into the bilingual clone.
    expect(document.querySelectorAll(".mom_graphic")).toHaveLength(1);
    expect(mainText.nextElementSibling?.textContent).toContain("译:A purely human heritage gives a familiar body.");
    expect(mainText.nextElementSibling?.textContent).not.toContain("Mother portrait");

    translator.restore();
    expect(document.body.innerHTML).toBe(before);
  });

  it("translates mixed div prose containing inline links as one whole sentence while leaving link-only nav bars independent", async () => {
    document.body.innerHTML =
      '<div class="nav"><a href="/a">Home</a> | <a href="/b">Docs</a></div>' +
      '<div class="prose">Read <a href="/guide" class="doc-link">the guide</a> now.</div>';

    const navLinks = Array.from(document.querySelectorAll(".nav a"));
    const prose = document.querySelector<HTMLElement>(".prose")!;
    const proseLink = prose.querySelector("a")!;
    const before = document.body.innerHTML;

    const roots = collectTranslationRoots(document.body, { preserveInlineContext: true });
    expect(roots).toEqual([...navLinks, prose]);

    const provider = whitespaceCollapsingProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();
    expect(translator.translatedCount).toBe(3);
    expect(prose.querySelector("a")).toBe(proseLink);
    expect(prose.textContent).toBe("译:Read 译:the guide 译:now.");

    translator.restore();
    expect(document.body.innerHTML).toBe(before);
  });

  it("dynamically translates Vue/SPA scene replacements inside a mixed container without looping", async () => {
    document.body.innerHTML =
      '<span class="mainText" style="white-space: pre-wrap">' +
      "<h1>Scene One</h1>First scene text.<i>Italic one</i>" +
      "</span>";
    const mainText = document.querySelector<HTMLElement>(".mainText")!;
    const provider = whitespaceCollapsingProvider();
    const translator = new PageTranslator(document, provider, {
      displayMode: "translation",
      shouldTranslateRoot: (root: HTMLElement) =>
        !/[\u3400-\u9fff]/u.test(sourceFingerprint(root, { excludeNestedRoots: true })),
    });
    await translator.translateAll(document.body, true);
    translator.observe();
    expect(mainText.textContent).toContain("译:First scene text.");

    // Simulate SPA transitioning to a new scene inside .mainText
    mainText.innerHTML = "<h1>Scene Two</h1>Second scene text.<i>Italic two</i>";
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mainText.querySelector("h1")!.textContent).toBe("译:Scene Two");
    expect(mainText.textContent).toContain("译:Second scene text.");
    expect(mainText.querySelector("i")!.textContent).toBe("译:Italic two");

    const callsAfterTransition = provider.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(provider.requests.length).toBe(callsAfterTransition);

    translator.restore();
  });
});

describe("standalone keyboard shortcut and keycap badge exclusions", () => {
  it("identifies standalone shortcut badges without excluding real words", () => {
    for (const keycap of ["Q", "W", "E", "x", "Esc", "F1", "F12", "⇑Q", "⇧K", "⌘K", "Ctrl+S", "Alt+F4", "Shift+Tab"]) {
      expect(isStandaloneShortcutLabel(keycap)).toBe(true);
    }
    for (const prose of ["Yes", "No", "Next", "Home", "Back", "Delete", "Enter", "Human", "Data", "I have a cat."]) {
      expect(isStandaloneShortcutLabel(prose)).toBe(false);
    }
  });

  it("skips hotkey badges while preserving single-letter words inside prose and normal button labels", async () => {
    document.body.innerHTML =
      '<div class="keybindDisplay"><span>Q</span></div>' +
      '<div class="keybindDisplay"><span>W</span></div>' +
      '<div class="keybindDisplay"><span>Esc</span></div>' +
      '<div class="keybindDisplay"><span>F1</span></div>' +
      '<div class="keybindDisplay"><span>⇑Q</span></div>' +
      '<button id="choice"><span class="btnTxt">Human</span></button>' +
      '<button id="cmd"><span>Search</span><span class="shortcut">⌘K</span></button>' +
      "<p>I have <em>a</em> cat.</p>";

    const roots = collectTranslationRoots(document.body, { preserveInlineContext: true }) as HTMLElement[];
    expect(roots.map((el) => el.id || el.tagName)).toEqual(["choice", "cmd", "P"]);

    const provider = whitespaceCollapsingProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();

    expect(Array.from(document.querySelectorAll(".keybindDisplay span")).map((el) => el.textContent)).toEqual([
      "Q", "W", "Esc", "F1", "⇑Q",
    ]);
    expect(document.querySelector("#choice")!.textContent).toBe("译:Human");
    expect(document.querySelector("#cmd .shortcut")!.textContent).toBe("⌘K");
    expect(document.querySelector("#cmd span")!.textContent).toBe("译:Search");
    expect(document.querySelector("p")!.textContent).toBe("译:I have 译:a 译:cat.");

    translator.restore();
  });
});

describe("plain-text multi-paragraph and oversized slot splitting (Microsoft & Google Free)", () => {
  it("splits blank-line paragraphs and oversized single text slots while preserving exact separators", async () => {
    const sentChunks: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const items = JSON.parse(String(init?.body)) as string[];
      sentChunks.push(items);
      return Response.json(items.map((text, idx) => ({
        translations: [{
          text: text.includes("First paragraph")
            ? "第一段内容。"
            : text.includes("Last paragraph")
              ? "最后一段内容。"
              : `维克多探索边境星系并建立工业帝国的第${idx + 1}段译文。`.repeat(Math.max(1, Math.ceil(text.length / 80))),
          to: "zh-Hans",
        }],
      })));
    }));

    const msFree = builtinFreeEngineConfig(BUILTIN_MICROSOFT_ENGINE_ID)!;
    const longParagraph = Array.from(
      { length: 65 },
      (_, i) => `Victor Steele explored frontier sector ${i + 1} and expanded his industrial fleet across the stars.`,
    ).join(" ");
    const html = `<span data-flt-text-id="0">\n\nFirst paragraph.\n\n${longParagraph}\n\nLast paragraph.\n\n</span>`;

    const result = await translateWithExternalEngine(msFree, {
      html,
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });

    // Every individual sent piece stays well below Edge's 5,000-char limit
    expect(sentChunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of sentChunks) {
      expect(chunk.reduce((sum, item) => sum + item.length, 0)).toBeLessThanOrEqual(4800);
      for (const item of chunk) expect(item.length).toBeLessThanOrEqual(3600);
    }
    expect(result).toContain("\n\n第一段内容。\n\n维克多探索边境星系");
    expect(result).toContain("\n\n最后一段内容。\n\n");
  });

  it("preserves exact blank-line breaks on Google Free batch endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body));
      const queries = params.getAll("q");
      return Response.json(queries.map((q) => `谷歌:${q}`));
    }));

    const googleFree = builtinFreeEngineConfig(BUILTIN_GOOGLE_ENGINE_ID)!;
    const html = '<span data-flt-text-id="0">Para A.\n\n***\n\nPara B.</span>';
    const result = await translateWithExternalEngine(googleFree, {
      html,
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(result).toBe('<span data-flt-text-id="0">谷歌:Para A.\n\n***\n\n谷歌:Para B.</span>');
  });

  it("isolates a single failed preformatted paragraph so other paragraphs in the same scene still translate", async () => {
    document.body.innerHTML =
      '<span class="mainText" style="white-space: pre-wrap">' +
      "First paragraph translates cleanly.\n\n" +
      "FAIL_THIS_PARAGRAPH\n\n" +
      "Third paragraph also translates cleanly." +
      "</span>";
    const mainText = document.querySelector<HTMLElement>(".mainText")!;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (request: TranslationRequest) => {
        if (request.html.includes("FAIL_THIS_PARAGRAPH")) {
          // Simulate an unrecoverable empty slot on paragraph 2 only
          return '<span data-flt-text-id="0"></span>';
        }
        const body = new DOMParser().parseFromString(request.html, "text/html").body;
        for (const slot of body.querySelectorAll("span[data-flt-text-id]")) {
          slot.textContent = `译:${slot.textContent}`;
        }
        return body.innerHTML;
      },
    };
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();
    expect(translator.translatedCount).toBe(1);
    expect(translator.failedCount).toBe(0);
    expect(mainText.textContent).toBe(
      "译:First paragraph translates cleanly.\n\n" +
      "FAIL_THIS_PARAGRAPH\n\n" +
      "译:Third paragraph also translates cleanly.",
    );
  });

  it("translates nested <label><div class='label'>...<div class='sub'>...</div></div></label>, Selectize dropdowns, icon buttons, <legend>, <caption>, and prose placeholders on itch.io/game/new without dropping fields or corrupting URLs", async () => {
    document.body.innerHTML = `
      <form class="game_search">
        <input type="text" class="search_input" placeholder="Search for games, jams, tags or creators">
      </form>
      <div class="edit_game_page form">
        <h2>Create a new <span class="user_classification_noun">project</span></h2>
        <div class="input_row">
          <label>
            <div class="label">Project URL</div>
            <div class="domain_wrapper">
              <span class="domain">https://kerberos255.itch.io/</span>
              <input type="text" class="slug_input">
            </div>
          </label>
        </div>
        <div class="input_row">
          <label>
            <div class="label">
              Short description or tagline
              <div class="sub">Shown when we link to your <span class="user_classification_noun">project</span>. Avoid duplicating your <span class="user_classification_noun">project</span>'s title</div>
            </div>
            <input type="text" class="tagline_input" placeholder="Optional">
          </label>
        </div>
        <div class="input_row">
          <label>
            <div class="label">
              Classification
              <div class="sub">What are you uploading?</div>
            </div>
            <div class="selectize-control single">
              <div class="selectize-input items full has-options has-items">
                <div class="option" data-value="game">Games <span class="sub">— A piece of software you can play</span></div>
                <input type="text" autocomplete="off">
              </div>
            </div>
          </label>
        </div>
        <div class="input_row">
          <label>
            <div class="label">
              Gameplay video or trailer
              <div class="sub">Provide a link to a YouTube or Vimeo video</div>
            </div>
            <input type="text" class="video_input" placeholder="eg. https://www.youtube.com/watch?v=-51PdA47sP">
          </label>
        </div>
        <fieldset>
          <legend>Pricing</legend>
          <div class="payment_modes">
            <button type="button" role="checkbox" class="payment_mode_free active">
              <span class="icon icon-checkbox-checked"></span>
              <span class="label">$0 or donate</span>
            </button>
          </div>
          <input type="text" class="money_input" placeholder="$2.00">
        </fieldset>
        <table>
          <caption>Uploads</caption>
        </table>
      </div>
    `;

    const beforeHtml = document.body.innerHTML;
    const provider = whitespaceCollapsingProvider();
    const translator = new PageTranslator(document, provider, {
      displayMode: "translation",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });

    await translator.translateAll();
    expect(translator.failedCount).toBe(0);

    // Empty decorative <span class="icon"></span> must never emit empty <span></span> into provider HTML
    for (const req of provider.requests) {
      expect(req.html).not.toContain("<span></span>");
      expect(req.html).not.toContain("https://kerberos255.itch.io/");
    }

    // Nested <div class="label"> titles inside <label> must not be jumped over or dropped
    const labels = Array.from(document.querySelectorAll(".input_row .label"));
    expect(labels[0]!.textContent).toBe("译:Project URL");
    expect(labels[1]!.childNodes[0]!.textContent?.trim()).toBe("译:Short description or tagline");
    expect(labels[1]!.querySelector(".sub")!.textContent).toContain("译:Shown when we link to your");
    expect(labels[2]!.childNodes[0]!.textContent?.trim()).toBe("译:Classification");
    expect(labels[2]!.querySelector(".sub")!.textContent).toBe("译:What are you uploading?");
    expect(labels[3]!.childNodes[0]!.textContent?.trim()).toBe("译:Gameplay video or trailer");
    expect(labels[3]!.querySelector(".sub")!.textContent).toBe("译:Provide a link to a YouTube or Vimeo video");

    // Selectize selected item inside <label> translates cleanly
    expect(document.querySelector(".selectize-input .option")!.textContent).toContain("译:Games");
    expect(document.querySelector(".selectize-input .option .sub")!.textContent).toContain("译:— A piece of software you can play");

    // Standalone URL prefix in .domain_wrapper must stay untouched
    expect(document.querySelector(".domain")!.textContent).toBe("https://kerberos255.itch.io/");

    // <legend>, <caption>, and icon button label translate cleanly
    expect(document.querySelector("legend")!.textContent).toBe("译:Pricing");
    expect(document.querySelector("caption")!.textContent).toBe("译:Uploads");
    expect(document.querySelector(".payment_mode_free .label")!.textContent).toBe("译:$0 or donate");

    // Human-prose placeholders translate while URL/currency placeholders stay untouched
    expect(document.querySelector(".search_input")!.getAttribute("placeholder")).toBe("译:Search for games, jams, tags or creators");
    expect(document.querySelector(".tagline_input")!.getAttribute("placeholder")).toBe("译:Optional");
    expect(document.querySelector(".video_input")!.getAttribute("placeholder")).toBe("eg. https://www.youtube.com/watch?v=-51PdA47sP");
    expect(document.querySelector(".money_input")!.getAttribute("placeholder")).toBe("$2.00");

    // sourceTextSample with translator.originalTextForNode reads original English even after in-place mutation
    const sample = sourceTextSample(document, 4096, (node) => translator.originalTextForNode(node));
    expect(sample).toContain("Short description or tagline");
    expect(sample).not.toContain("译:");

    translator.restore();
    expect(document.body.innerHTML).toBe(beforeHtml);
  });
});


