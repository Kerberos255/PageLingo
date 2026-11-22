import { afterEach, describe, expect, it } from "vitest";
import type { TranslationRequest } from "../src/core/provider";
import { isGeneratedNode } from "../src/core/dom-policy";
import {
  DEFAULT_SETTINGS,
  DEFAULT_VIDEO_SUBTITLE_SETTINGS,
  normalizeVideoSubtitleSettings,
  type PageLingoSettings,
} from "../src/shared/settings";
import {
  alignManualTargetCues,
  filterSoundEffectText,
  findActiveCueIndex,
  mergeAsrCues,
  parseBilibiliSubtitleJson,
  parseWebVtt,
  parseYouTubeJson3,
  parseYouTubeTimedTextXml,
  prepareSubtitleCues,
} from "../src/video-translation/subtitle-cues";
import { detectVideoPlatform, type DiscoveredSubtitleTrack } from "../src/video-translation/platform-adapters";
import { VideoSubtitleManager } from "../src/video-translation/video-subtitle-controller";

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById("pagelingo-video-subtitle-style")?.remove();
});

function makeSettings(overrides: Partial<PageLingoSettings["videoSubtitle"]> = {}, displayMode: "translation" | "bilingual" = "translation"): PageLingoSettings {
  return {
    ...DEFAULT_SETTINGS,
    displayMode,
    videoSubtitle: {
      ...DEFAULT_VIDEO_SUBTITLE_SETTINGS,
      ...overrides,
    },
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 15));
}

describe("video subtitle cue parsing & processing", () => {
  it("parses WebVTT with headers, cue identifiers, settings, and entities", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE ignore this comment block",
      "still ignored",
      "",
      "1",
      "00:00:01.000 --> 00:00:03.500 align:start position:0%",
      "<i>Hello</i> &amp; welcome",
      "",
      "00:04.000 --> 00:06.250",
      "Second line",
      "continues here",
    ].join("\n");

    const cues = parseWebVtt(vtt);
    expect(cues).toEqual([
      { startTime: 1, endTime: 3.5, text: "Hello & welcome" },
      { startTime: 4, endTime: 6.25, text: "Second line continues here" },
    ]);
  });

  it("parses YouTube json3 and both XML timedtext formats", () => {
    const json3 = {
      events: [
        { tStartMs: 1000, dDurationMs: 2500, segs: [{ utf8: "Quick " }, { utf8: "start." }] },
        { tStartMs: 3600, dDurationMs: 1400, segs: [{ utf8: "\n" }] },
      ],
    };
    expect(parseYouTubeJson3(json3)).toEqual([
      { startTime: 1, endTime: 3.5, text: "Quick start." },
    ]);

    const xml1 = `<transcript><text start="0.5" dur="2.0">First &apos;cue&apos;</text></transcript>`;
    expect(parseYouTubeTimedTextXml(xml1)).toEqual([
      { startTime: 0.5, endTime: 2.5, text: "First 'cue'" },
    ]);

    const xmlSrv3 = `<timedtext><body><p t="2000" d="1500"><s>Second</s> <s>cue</s></p></body></timedtext>`;
    expect(parseYouTubeTimedTextXml(xmlSrv3)).toEqual([
      { startTime: 2, endTime: 3.5, text: "Second cue" },
    ]);
  });

  it("parses Bilibili subtitle JSON", () => {
    const payload = {
      body: [
        { from: 1.2, to: 3.4, content: "Hello Bilibili" },
        { from: 4.0, to: 3.0, content: "invalid backwards cue" },
      ],
    };
    expect(parseBilibiliSubtitleJson(payload)).toEqual([
      { startTime: 1.2, endTime: 3.4, text: "Hello Bilibili" },
    ]);
  });

  it("filters sound effects and merges choppy ASR fragments into natural sentences", () => {
    expect(filterSoundEffectText("[Music]")).toBe("");
    expect(filterSoundEffectText("♪ background tune ♪")).toBe("");
    expect(filterSoundEffectText("(Applause) Thank you everyone!")).toBe("Thank you everyone!");
    expect(filterSoundEffectText("（掌声）大家好")).toBe("大家好");

    const asrCues = [
      { startTime: 0.0, endTime: 1.1, text: "[Music]" },
      { startTime: 1.2, endTime: 2.1, text: "Today we are" },
      { startTime: 2.2, endTime: 3.4, text: "building a subtitle engine." },
      { startTime: 3.5, endTime: 4.8, text: "Next topic starts here." },
    ];
    const prepared = prepareSubtitleCues(asrCues, { filterSoundEffects: true, mergeAsr: true });
    expect(prepared).toEqual([
      { startTime: 1.2, endTime: 3.4, text: "Today we are building a subtitle engine." },
      { startTime: 3.5, endTime: 4.8, text: "Next topic starts here." },
    ]);

    const manualMerged = mergeAsrCues([
      { startTime: 0, endTime: 2, text: "Part one" },
      { startTime: 4, endTime: 5, text: "After long pause" },
    ]);
    expect(manualMerged).toHaveLength(2);
  });

  it("aligns manual target captions onto source cues and finds active cues in O(log n)", () => {
    const source = [
      { startTime: 1, endTime: 3, text: "Hello world." },
      { startTime: 4, endTime: 6, text: "Second line." },
    ];
    const target = [
      { startTime: 1.1, endTime: 2.9, text: "你好世界。" },
      { startTime: 4.0, endTime: 5.8, text: "第二行。" },
    ];
    const aligned = alignManualTargetCues(source, target);
    expect(aligned[0]?.translatedText).toBe("你好世界。");
    expect(aligned[1]?.translatedText).toBe("第二行。");

    expect(findActiveCueIndex(aligned, 0.5)).toBe(-1);
    expect(findActiveCueIndex(aligned, 1.5)).toBe(0);
    expect(findActiveCueIndex(aligned, 3.5)).toBe(-1);
    expect(findActiveCueIndex(aligned, 4.0)).toBe(1);
    expect(findActiveCueIndex(aligned, 6.1)).toBe(-1);
  });

  it("normalizes and clamps video subtitle settings safely", () => {
    const normalized = normalizeVideoSubtitleSettings({
      enabled: true,
      showPlayerButton: false,
      engineId: "builtin-google-free",
      displayMode: "translation",
      order: "translation-top",
      learningMode: true,
      translationFontSize: 99,
      sourceFontSize: 4,
      translationColor: "#ff00ff",
      backgroundOpacity: 150,
    });
    expect(normalized).toEqual({
      enabled: true,
      showPlayerButton: false,
      engineId: "builtin-google-free",
      displayMode: "translation",
      order: "translation-top",
      learningMode: true,
      preferManualCaptions: true,
      filterSoundEffects: true,
      mergeAsrSegments: true,
      translationFontSize: 32,
      sourceFontSize: 12,
      translationColor: "#ffffff",
      backgroundOpacity: 90,
    });
  });

  it("detects YouTube, Bilibili, and generic HTML5 platforms", () => {
    expect(detectVideoPlatform("www.youtube.com")).toBe("youtube");
    expect(detectVideoPlatform("youtu.be")).toBe("youtube");
    expect(detectVideoPlatform("www.bilibili.com")).toBe("bilibili");
    expect(detectVideoPlatform("example.com")).toBe("html5");
  });
});

describe("VideoSubtitleManager end-to-end overlay controller", () => {
  it("stays idle when disabled and activates live when enabled in settings", async () => {
    const container = document.createElement("div");
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 1.5, writable: true, configurable: true });
    container.append(video);
    document.body.append(container);

    let restoreCount = 0;
    const calls: TranslationRequest[] = [];
    const track: DiscoveredSubtitleTrack = {
      platform: "html5",
      videoKey: "test:1",
      sourceLanguage: "en",
      isAsr: false,
      hasManualTarget: false,
      cues: [
        { startTime: 1, endTime: 3, text: "Quick start opens the dashboard." },
        { startTime: 4, endTime: 6, text: "Custom setup guides every step." },
      ],
      restoreNativeTrack: () => { restoreCount += 1; },
    };

    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: false }),
      discoverFn: async () => track,
      platformFn: () => "html5",
      provider: {
        translateHtml: async (req) => {
          calls.push(req);
          return req.html
            .replace("Quick start opens the dashboard.", "快速启动会打开控制面板。")
            .replace("Custom setup guides every step.", "自定义设置会引导每一步。");
        },
      },
    });

    await manager.start();
    expect(manager.getActiveSessionCount()).toBe(0);
    expect(container.querySelector('[data-flt-generated="video-subtitle"]')).toBeNull();

    // Enable live with dedicated engineId and learning mode.
    await manager.applySettings(makeSettings({
      enabled: true,
      engineId: "builtin-microsoft-free",
      displayMode: "bilingual",
      order: "translation-top",
      learningMode: true,
      translationFontSize: 24,
      sourceFontSize: 16,
      translationColor: "#fde047",
      backgroundOpacity: 80,
    }));
    await flushAsync();

    expect(manager.getActiveSessionCount()).toBe(1);
    expect(calls.length).toBe(2);
    expect(calls[0]?.engineId).toBe("builtin-microsoft-free");

    const host = container.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    expect(host).not.toBeNull();
    expect(isGeneratedNode(host)).toBe(true);
    expect(container.getAttribute("data-pagelingo-subtitle-active")).toBe("true");

    const shadow = host.shadowRoot!;
    const wrap = shadow.querySelector<HTMLDivElement>(".pl-sub-wrap")!;
    const box = shadow.querySelector<HTMLDivElement>(".pl-sub-box")!;
    const srcEl = shadow.querySelector<HTMLDivElement>(".pl-sub-source")!;
    const transEl = shadow.querySelector<HTMLDivElement>(".pl-sub-translation")!;

    expect(wrap.hidden).toBe(false);
    expect(box.dataset.order).toBe("translation-top");
    expect(box.dataset.learning).toBe("true");
    expect(wrap.style.getPropertyValue("--pl-sub-trans-size")).toBe("24px");
    expect(wrap.style.getPropertyValue("--pl-sub-src-size")).toBe("16px");
    expect(wrap.style.getPropertyValue("--pl-sub-trans-color")).toBe("#fde047");
    expect(wrap.style.getPropertyValue("--pl-sub-bg-alpha")).toBe("0.8");
    expect(srcEl.textContent).toBe("Quick start opens the dashboard.");
    expect(transEl.textContent).toBe("快速启动会打开控制面板。");

    // Clicking box in learning mode reveals translation, and advancing to next cue resets reveal.
    box.click();
    expect(box.dataset.revealed).toBe("true");
    video.currentTime = 4.5;
    video.dispatchEvent(new Event("timeupdate"));
    expect(box.dataset.revealed).toBe("false");
    expect(srcEl.textContent).toBe("Custom setup guides every step.");
    expect(transEl.textContent).toBe("自定义设置会引导每一步。");

    // Player quick toggle cycles bilingual -> translation -> off -> bilingual.
    const toggleBtn = container.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(toggleBtn).not.toBeNull();
    expect(isGeneratedNode(toggleBtn)).toBe(true);
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");

    toggleBtn.click();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("translation");
    expect(srcEl.hidden).toBe(true);
    expect(transEl.textContent).toBe("自定义设置会引导每一步。");

    toggleBtn.click();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("off");
    expect(wrap.hidden).toBe(true);
    expect(container.hasAttribute("data-pagelingo-subtitle-active")).toBe(false);
    expect(restoreCount).toBe(1);

    toggleBtn.click();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(wrap.hidden).toBe(false);
    expect(container.getAttribute("data-pagelingo-subtitle-active")).toBe("true");

    // Turning off globally cleans up overlay, button, and restores native captions.
    await manager.applySettings(makeSettings({ enabled: false }));
    expect(manager.getActiveSessionCount()).toBe(0);
    expect(container.querySelector('[data-flt-generated="video-subtitle"]')).toBeNull();
    expect(container.querySelector('[data-flt-generated="video-subtitle-control"]')).toBeNull();
    expect(restoreCount).toBe(2);

    manager.dispose();
  });

  it("renders manual target captions directly with zero translation requests and honors follow displayMode", async () => {
    const container = document.createElement("div");
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 2.0, writable: true, configurable: true });
    container.append(video);
    document.body.append(container);

    let callCount = 0;
    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, displayMode: "follow" }, "translation"),
      discoverFn: async () => ({
        platform: "youtube",
        videoKey: "yt:abc->manual",
        sourceLanguage: "en",
        isAsr: false,
        hasManualTarget: true,
        cues: [{ startTime: 1, endTime: 4, text: "Official English line.", translatedText: "官方人工中文字幕。" }],
      }),
      platformFn: () => "youtube",
      provider: {
        translateHtml: async () => {
          callCount += 1;
          return "should not be called";
        },
      },
    });

    await manager.start();
    await flushAsync();

    expect(callCount).toBe(0);
    const host = container.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const srcEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-source")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    // displayMode "follow" + webpage "translation" -> translation-only!
    expect(srcEl.hidden).toBe(true);
    expect(transEl.textContent).toBe("官方人工中文字幕。");

    // Switching webpage displayMode to bilingual updates "follow" live.
    await manager.applySettings(makeSettings({ enabled: true, displayMode: "follow" }, "bilingual"));
    expect(srcEl.hidden).toBe(false);
    expect(srcEl.textContent).toBe("Official English line.");
    expect(transEl.textContent).toBe("官方人工中文字幕。");

    manager.dispose();
  });
});
