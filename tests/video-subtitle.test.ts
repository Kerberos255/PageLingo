import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  detectVideoPlatform,
  discoverBilibiliSubtitleDetailed,
  discoverHtml5Subtitle,
  discoverYouTubeSubtitleDetailed,
  extractBilibiliRouteIds,
  extractYouTubeVideoId,
  type DiscoveredSubtitleTrack,
  type FetchTrackTextOptions,
} from "../src/video-translation/platform-adapters";
import {
  registerAiSubtitleProvider,
  type AiSubtitleRequest,
} from "../src/video-translation/ai-subtitle-provider";
import { VideoSubtitleManager } from "../src/video-translation/video-subtitle-controller";

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById("pagelingo-video-subtitle-style")?.remove();
  registerAiSubtitleProvider(null);
});

function makeSettings(
  overrides: Partial<PageLingoSettings["videoSubtitle"]> = {},
  displayMode: "translation" | "bilingual" = "translation",
  targetLanguage: string = DEFAULT_SETTINGS.targetLanguage,
): PageLingoSettings {
  return {
    ...DEFAULT_SETTINGS,
    displayMode,
    targetLanguage,
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
    expect(DEFAULT_VIDEO_SUBTITLE_SETTINGS.autoStart).toBe(false);
    expect(DEFAULT_VIDEO_SUBTITLE_SETTINGS.showPlayerButton).toBe(true);

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
      autoStart: false,
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
    expect(normalizeVideoSubtitleSettings({ autoStart: true }).autoStart).toBe(true);
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
      autoStart: true,
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
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, displayMode: "follow" }, "translation"),
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
    await manager.applySettings(makeSettings({ enabled: true, autoStart: true, displayMode: "follow" }, "bilingual"));
    expect(srcEl.hidden).toBe(false);
    expect(srcEl.textContent).toBe("Official English line.");
    expect(transEl.textContent).toBe("官方人工中文字幕。");

    manager.dispose();
  });

  it("mounts quick toggle in Bilibili bpx-player controls for <bwp-video>, shows login/no-sub states, retries on click, and ignores sidebar previews", async () => {
    const playerContainer = document.createElement("div");
    playerContainer.className = "bpx-player-container";
    const primaryArea = document.createElement("div");
    primaryArea.className = "bpx-player-primary-area";
    const videoArea = document.createElement("div");
    videoArea.className = "bpx-player-video-area";
    const videoWrap = document.createElement("div");
    videoWrap.className = "bpx-player-video-wrap";

    // Bilibili WASM HEVC player element (<bwp-video>) instead of native <video>.
    const bwpVideo = document.createElement("bwp-video");
    Object.defineProperty(bwpVideo, "wrappedJSObject", {
      value: { currentTime: 2.2 },
      configurable: true,
    });
    videoWrap.append(bwpVideo);

    const controlWrap = document.createElement("div");
    controlWrap.className = "bpx-player-control-wrap";
    const bottomRight = document.createElement("div");
    bottomRight.className = "bpx-player-control-bottom-right";
    const nativeSubBtn = document.createElement("div");
    nativeSubBtn.className = "bpx-player-ctrl-btn bpx-player-ctrl-subtitle";
    bottomRight.append(nativeSubBtn);
    controlWrap.append(bottomRight);

    videoArea.append(videoWrap, controlWrap);
    primaryArea.append(videoArea);
    playerContainer.append(primaryArea);

    // Sidebar hover-preview <video> outside .bpx-player-video-area must be ignored.
    const sidebarCard = document.createElement("div");
    sidebarCard.className = "bili-video-card__image";
    const previewVideo = document.createElement("video");
    sidebarCard.append(previewVideo);

    document.body.append(playerContainer, sidebarCard);

    let attempt = 0;
    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "bilibili",
      discoverDetailedFn: async () => {
        attempt += 1;
        if (attempt === 1) {
          return { track: null, status: "need_login" };
        }
        return {
          status: "ready",
          track: {
            platform: "bilibili",
            videoKey: "bili:BV1test:2002:ai-en",
            sourceLanguage: "en",
            isAsr: true,
            hasManualTarget: false,
            cues: [{ startTime: 1.0, endTime: 4.0, text: "Hello from Bilibili WASM player." }],
          },
        };
      },
      provider: {
        translateHtml: async (req) => req.html.replace("Hello from Bilibili WASM player.", "来自 B 站 WASM 播放器的问候。"),
      },
    });

    await manager.start();
    await flushAsync();

    // Only the real player attached; sidebar hover preview was ignored.
    expect(manager.getActiveSessionCount()).toBe(1);
    expect(sidebarCard.querySelector('[data-flt-generated="video-subtitle-control"]')).toBeNull();

    // Quick toggle button is mounted directly in .bpx-player-control-bottom-right even before track is ready.
    const toggleBtn = bottomRight.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.classList.contains("pagelingo-sub-toggle-bilibili")).toBe(true);
    expect(toggleBtn.classList.contains("bpx-player-ctrl-btn")).toBe(false);
    expect(toggleBtn.querySelector(".pagelingo-sub-toggle-icon")).not.toBeNull();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("need-login");
    expect(toggleBtn.textContent).toBe("需登录");

    // Clicking the button in need-login state retries subtitle discovery and renders translated cue.
    toggleBtn.click();
    await flushAsync();

    expect(attempt).toBe(2);
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(toggleBtn.textContent).toBe("双语");
    expect(videoArea.getAttribute("data-pagelingo-subtitle-active")).toBe("true");

    const host = videoArea.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const srcEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-source")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(srcEl.textContent).toBe("Hello from Bilibili WASM player.");
    expect(transEl.textContent).toBe("来自 B 站 WASM 播放器的问候。");

    manager.dispose();
  });

  it("reads Bilibili playback time from .bpx-player-ctrl-time-current fallback when <bwp-video> hides currentTime", async () => {
    const videoArea = document.createElement("div");
    videoArea.className = "bpx-player-video-area";
    const bwpVideo = document.createElement("bwp-video");
    const clockEl = document.createElement("span");
    clockEl.className = "bpx-player-ctrl-time-current";
    clockEl.textContent = "01:05";
    const bottomRight = document.createElement("div");
    bottomRight.className = "bpx-player-control-bottom-right";
    videoArea.append(bwpVideo, clockEl, bottomRight);
    document.body.append(videoArea);

    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, displayMode: "bilingual" }),
      platformFn: () => "bilibili",
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "bilibili",
          videoKey: "bili:BV1clock:3003:en",
          sourceLanguage: "en",
          isAsr: false,
          hasManualTarget: true,
          cues: [{ startTime: 62, endTime: 68, text: "At one minute five.", translatedText: "在 1 分 05 秒。" }],
        },
      }),
    });

    await manager.start();
    await flushAsync();

    const host = videoArea.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(transEl.textContent).toBe("在 1 分 05 秒。");

    manager.dispose();
  });
});

describe("Bilibili subtitle discovery", () => {
  it("parses all Bilibili watch URLs including multi-part, av, bangumi, playlist, and embed player", () => {
    expect(extractBilibiliRouteIds("https://www.bilibili.com/")).toBeNull();
    expect(extractBilibiliRouteIds("https://www.bilibili.com/video/BV1xx411c7mD/?p=3")).toEqual({
      bvid: "BV1xx411c7mD",
      page: 3,
    });
    expect(extractBilibiliRouteIds("https://www.bilibili.com/video/av170001?p=2")).toEqual({
      aid: "170001",
      page: 2,
    });
    expect(extractBilibiliRouteIds("https://www.bilibili.com/bangumi/play/ep829412")).toEqual({
      epId: "829412",
      page: 1,
    });
    expect(extractBilibiliRouteIds("https://www.bilibili.com/list/watchlater?bvid=BV1ab411c7mD&p=2")).toEqual({
      bvid: "BV1ab411c7mD",
      page: 2,
    });
    expect(extractBilibiliRouteIds("https://player.bilibili.com/player.html?bvid=BV1ab411c7mD&cid=998877")).toEqual({
      bvid: "BV1ab411c7mD",
      cid: "998877",
      page: 1,
    });
  });

  it("ignores stale SPA __INITIAL_STATE__, resolves ?p=2 cid via view API, queries /x/player/wbi/v2 directly, and fetches CDN subtitle with credentials omit", async () => {
    // Stale SSR script from previous video before SPA navigation!
    const staleScript = document.createElement("script");
    staleScript.textContent = `window.__INITIAL_STATE__={"videoData":{"bvid":"BV1OLDVIDEO1","aid":111,"cid":11101}};`;
    document.body.append(staleScript);

    const calls: Array<{ url: string; credentials: "include" | "omit" | undefined }> = [];
    const result = await discoverBilibiliSubtitleDetailed(
      {
        targetLanguage: "zh-Hans",
        preferManualCaptions: true,
        filterSoundEffects: true,
        mergeAsrSegments: false,
      },
      {
        href: "https://www.bilibili.com/video/BV1NEWVIDEO2/?p=2",
        doc: document,
        fetchText: async (url: string, opts?: FetchTrackTextOptions) => {
          calls.push({ url, credentials: opts?.credentials });
          if (url.startsWith("https://api.bilibili.com/x/web-interface/view?")) {
            return JSON.stringify({
              code: 0,
              data: {
                bvid: "BV1NEWVIDEO2",
                aid: 222,
                cid: 22201,
                pages: [
                  { page: 1, cid: 22201 },
                  { page: 2, cid: 22202 },
                ],
              },
            });
          }
          if (url.startsWith("https://api.bilibili.com/x/player/wbi/v2?")) {
            const u = new URL(url);
            expect(u.searchParams.get("bvid")).toBe("BV1NEWVIDEO2");
            expect(u.searchParams.get("cid")).toBe("22202");
            return JSON.stringify({
              code: 0,
              data: {
                login_mid: 123456,
                subtitle: {
                  subtitles: [
                    { lan: "ai-en", ai_status: 2, subtitle_url: "http://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/22202.json" },
                  ],
                },
              },
            });
          }
          if (url === "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/22202.json") {
            return JSON.stringify({
              body: [{ from: 1.0, to: 3.5, content: "Part two caption." }],
            });
          }
          throw new Error(`Unexpected URL: ${url}`);
        },
      },
    );

    expect(result.status).toBe("ready");
    expect(result.track?.videoKey).toBe("bili:BV1NEWVIDEO2:22202:ai-en");
    expect(result.track?.sourceLanguage).toBe("en");
    expect(result.track?.cues).toEqual([{ startTime: 1.0, endTime: 3.5, text: "Part two caption." }]);
    expect(calls.some((c) => c.url.includes("/x/player/v2?"))).toBe(false);
    const cdnCall = calls.find((c) => c.url.includes("aisubtitle.hdslb.com"));
    expect(cdnCall?.credentials).toBe("omit");
  });

  it("reports need_login when Bilibili /x/player/wbi/v2 returns empty subtitles for anonymous viewers", async () => {
    const result = await discoverBilibiliSubtitleDetailed(
      {
        targetLanguage: "zh-Hans",
        preferManualCaptions: true,
        filterSoundEffects: true,
        mergeAsrSegments: true,
      },
      {
        href: "https://www.bilibili.com/video/BV1ANON12345?cid=55501",
        doc: document,
        fetchText: async (url: string) => {
          if (url === "https://api.bilibili.com/x/web-interface/nav") {
            return JSON.stringify({
              code: -101,
              data: {
                wbi_img: {
                  img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
                  sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
                },
              },
            });
          }
          if (url.startsWith("https://api.bilibili.com/x/player/wbi/v2?")) {
            return JSON.stringify({
              code: 0,
              data: {
                login_mid: 0,
                need_login_subtitle: true,
                subtitle: { subtitles: [] },
              },
            });
          }
          throw new Error(`Unexpected URL: ${url}`);
        },
      },
    );

    expect(result).toEqual({ track: null, status: "need_login" });
  });
});

describe("YouTube PO-token recovery, live DOM caption bridge, and Shorts", () => {
  it("extracts YouTube video IDs across watch, shorts, live, embed, and youtu.be URLs", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://www.youtube.com/shorts/abcDEF12345")).toBe("abcDEF12345");
    expect(extractYouTubeVideoId("https://www.youtube.com/live/live9876543")).toBe("live9876543");
    expect(extractYouTubeVideoId("https://youtu.be/shortLink99")).toBe("shortLink99");
    expect(extractYouTubeVideoId("https://www.youtube.com/")).toBeNull();
  });

  it("reports need_cc on PO-token empty timedtext and recovers full track when player resource carries pot", async () => {
    const moviePlayer = document.createElement("div");
    moviePlayer.id = "movie_player";
    Object.defineProperty(moviePlayer, "wrappedJSObject", {
      value: {
        getPlayerResponse: () => ({
          videoDetails: { videoId: "POTVID12345" },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  languageCode: "en",
                  vssId: ".en",
                  baseUrl: "https://www.youtube.com/api/timedtext?v=POTVID12345&lang=en&exp=xpe",
                },
              ],
            },
          },
        }),
      },
      configurable: true,
    });
    document.body.append(moviePlayer);

    const fetchMock = async (url: string): Promise<string> => {
      const parsed = new URL(url);
      if (parsed.searchParams.get("pot") === "LIVE_POT_TOKEN") {
        return JSON.stringify({
          events: [
            { tStartMs: 1000, dDurationMs: 2500, segs: [{ utf8: "Authenticated YouTube line." }] },
          ],
        });
      }
      // Simulate YouTube PO-token empty HTTP 200 body when pot is missing.
      return "";
    };

    const gated = await discoverYouTubeSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: true },
      { href: "https://www.youtube.com/watch?v=POTVID12345", doc: document, fetchText: fetchMock, resourceUrls: [] },
    );
    expect(gated).toEqual({ track: null, status: "need_cc" });

    const recovered = await discoverYouTubeSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: true },
      {
        href: "https://www.youtube.com/watch?v=POTVID12345",
        doc: document,
        fetchText: fetchMock,
        resourceUrls: [
          "https://www.youtube.com/api/timedtext?v=POTVID12345&lang=en&exp=xpe&pot=LIVE_POT_TOKEN&c=WEB",
        ],
      },
    );
    expect(recovered.status).toBe("ready");
    expect(recovered.track?.cues).toEqual([
      { startTime: 1, endTime: 3.5, text: "Authenticated YouTube line." },
    ]);
  });

  it("shows PL 开CC on YouTube need_cc, clicks native CC button, and translates live .ytp-caption-segment DOM captions", async () => {
    const moviePlayer = document.createElement("div");
    moviePlayer.id = "movie_player";
    moviePlayer.className = "html5-video-player";
    const video = document.createElement("video");
    const controls = document.createElement("div");
    controls.className = "ytp-right-controls";
    const ccBtn = document.createElement("button");
    ccBtn.className = "ytp-subtitles-button";
    ccBtn.setAttribute("aria-pressed", "false");
    controls.append(ccBtn);

    const captionContainer = document.createElement("div");
    captionContainer.className = "ytp-caption-window-container";
    moviePlayer.append(video, captionContainer, controls);
    document.body.append(moviePlayer);

    let ccClicked = 0;
    ccBtn.addEventListener("click", () => {
      ccClicked += 1;
      ccBtn.setAttribute("aria-pressed", "true");
      const seg = document.createElement("span");
      seg.className = "ytp-caption-segment";
      seg.textContent = "Live YouTube caption line.";
      captionContainer.replaceChildren(seg);
    });

    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "youtube",
      detectLanguageFn: async () => "en",
      discoverDetailedFn: async () => ({ track: null, status: "need_cc" }),
      provider: {
        translateHtml: async (req) => req.html
          .replace("Live YouTube caption line.", "YouTube 实时字幕行。")
          .replace("Second live caption.", "第二条实时字幕。"),
      },
    });

    await manager.start();
    await flushAsync();

    const toggleBtn = controls.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.querySelector(".pagelingo-sub-toggle-icon")).not.toBeNull();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("need-cc");
    expect(toggleBtn.textContent).toBe("开CC");

    // Clicking 开CC turns on YouTube native CC and activates live DOM caption translation.
    toggleBtn.click();
    await flushAsync();

    expect(ccClicked).toBe(1);
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(toggleBtn.textContent).toBe("双语");
    expect(moviePlayer.getAttribute("data-pagelingo-subtitle-active")).toBe("true");

    const host = moviePlayer.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const srcEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-source")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(srcEl.textContent).toBe("Live YouTube caption line.");
    expect(transEl.textContent).toBe("YouTube 实时字幕行。");

    // Subsequent DOM caption update translates live too.
    captionContainer.firstElementChild!.textContent = "Second live caption.";
    await flushAsync();
    expect(srcEl.textContent).toBe("Second live caption.");
    expect(transEl.textContent).toBe("第二条实时字幕。");

    // Toggling to off hides overlay and restores native caption visibility.
    toggleBtn.click(); // translation
    expect(srcEl.hidden).toBe(true);
    expect(transEl.textContent).toBe("第二条实时字幕。");
    toggleBtn.click(); // off
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("off");
    expect(moviePlayer.hasAttribute("data-pagelingo-subtitle-active")).toBe(false);

    manager.dispose();
  });

  it("attaches only to #shorts-player on /shorts/ routes even if a paused #movie_player stays in DOM", async () => {
    const prevUrl = window.location.href;
    window.history.replaceState({}, "", "/shorts/SHORT98765");
    try {
      const staleWatchPlayer = document.createElement("div");
      staleWatchPlayer.id = "movie_player";
      staleWatchPlayer.className = "html5-video-player";
      staleWatchPlayer.append(document.createElement("video"));

      const shortsPlayer = document.createElement("div");
      shortsPlayer.id = "shorts-player";
      shortsPlayer.className = "html5-video-player";
      shortsPlayer.append(document.createElement("video"));

      document.body.append(staleWatchPlayer, shortsPlayer);

      const manager = new VideoSubtitleManager({
        doc: document,
        loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true }),
        platformFn: () => "youtube",
        discoverDetailedFn: async () => ({ track: null, status: "no_subtitles" }),
      });

      await manager.start();
      await flushAsync();

      expect(manager.getActiveSessionCount()).toBe(1);
      expect(staleWatchPlayer.querySelector('[data-flt-generated="video-subtitle-control"]')).toBeNull();
      const shortsToggle = shortsPlayer.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]');
      expect(shortsToggle).not.toBeNull();
      expect(shortsToggle?.classList.contains("pagelingo-sub-toggle-floating")).toBe(true);

      manager.dispose();
    } finally {
      window.history.replaceState({}, "", prevUrl);
    }
  });
});

describe("Universal HTML5 async TextTracks, major player frameworks, and fullscreen preservation", () => {
  function makeMockTextTrack(initialMode: TextTrackMode = "disabled", language = "en") {
    const listeners = new Map<string, Set<EventListener>>();
    const cueArray: Array<{ startTime: number; endTime: number; text: string }> = [];
    const track = {
      kind: "subtitles",
      language,
      label: language.toUpperCase(),
      mode: initialMode,
      get cues() {
        return cueArray as unknown as TextTrackCueList;
      },
      addEventListener(type: string, fn: EventListener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: EventListener) {
        listeners.get(type)?.delete(fn);
      },
      emitCueChange() {
        for (const fn of listeners.get("cuechange") ?? []) fn(new Event("cuechange"));
      },
      pushCue(startTime: number, endTime: number, text: string) {
        cueArray.push({ startTime, endTime, text });
      },
    };
    return track;
  }

  it("waits for async disabled TextTracks to populate cues and merges incremental HLS cues on cuechange", async () => {
    const vjs = document.createElement("div");
    vjs.className = "video-js";
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 1.5, writable: true, configurable: true });
    const controlBar = document.createElement("div");
    controlBar.className = "vjs-control-bar";
    const playBtn = document.createElement("button");
    playBtn.className = "vjs-play-control";
    const fsBtn = document.createElement("button");
    fsBtn.className = "vjs-fullscreen-control";
    controlBar.append(playBtn, fsBtn);
    vjs.append(video, controlBar);

    // Unstyled decorative <video> without tracks must NOT get a quick toggle button.
    const heroBox = document.createElement("div");
    heroBox.append(document.createElement("video"));
    document.body.append(vjs, heroBox);

    const mockTrack = makeMockTextTrack("disabled", "en");
    const trackListListeners = new Map<string, Set<EventListener>>();
    const mockTrackList = Object.assign([mockTrack], {
      addEventListener(type: string, fn: EventListener) {
        if (!trackListListeners.has(type)) trackListListeners.set(type, new Set());
        trackListListeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: EventListener) {
        trackListListeners.get(type)?.delete(fn);
      },
    });
    Object.defineProperty(video, "textTracks", { value: mockTrackList, configurable: true });

    // Simulate Coursera / HLS.js populating cues asynchronously ~30ms after mode switches to hidden.
    let modeSetterTriggered = false;
    let currentMode: TextTrackMode = "disabled";
    Object.defineProperty(mockTrack, "mode", {
      get: () => currentMode,
      set: (next: TextTrackMode) => {
        currentMode = next;
        if (next === "hidden" && !modeSetterTriggered) {
          modeSetterTriggered = true;
          setTimeout(() => {
            mockTrack.pushCue(1, 3, "First HLS segment.");
            mockTrack.emitCueChange();
          }, 25);
        }
      },
    });

    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "html5",
      discoverDetailedFn: async (v, opts) => {
        const track = await discoverHtml5Subtitle(v, opts, { waitTimeoutMs: 400 });
        return track ? { track, status: "ready" } : { track: null, status: "no_subtitles" };
      },
      provider: {
        translateHtml: async (req) => req.html
          .replace("First HLS segment.", "第一段 HLS 字幕。")
          .replace("Second HLS segment.", "第二段 HLS 字幕。"),
      },
    });

    await manager.start();
    await new Promise((resolve) => setTimeout(resolve, 90));

    // Video.js inline toggle mounted inside .vjs-control-bar right BEFORE .vjs-fullscreen-control!
    const vjsToggle = controlBar.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(vjsToggle).not.toBeNull();
    expect(vjsToggle.classList.contains("pagelingo-sub-toggle-html5")).toBe(true);
    expect(vjsToggle.nextElementSibling).toBe(fsBtn);
    expect(vjsToggle.dataset.pagelingoSubMode).toBe("bilingual");

    // Decorative <video> outside known players has NO stray button.
    expect(heroBox.querySelector('[data-flt-generated="video-subtitle-control"]')).toBeNull();

    const host = vjs.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(transEl.textContent).toBe("第一段 HLS 字幕。");

    // Later HLS chunk arrives via cuechange and is merged + translated automatically.
    mockTrack.pushCue(5, 8, "Second HLS segment.");
    mockTrack.emitCueChange();
    video.currentTime = 6.0;
    video.dispatchEvent(new Event("timeupdate"));
    await flushAsync();

    expect(transEl.textContent).toBe("第二段 HLS 字幕。");

    manager.dispose();
  });

  it("mounts Plyr controls before fullscreen button and reparents overlay when an inner wrapper enters fullscreen", async () => {
    // Outer known player (.vp-player) contains an inner wrapper that enters fullscreen.
    const vpPlayer = document.createElement("div");
    vpPlayer.className = "vp-player";
    const innerFs = document.createElement("div");
    innerFs.className = "inner-stage";
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 1.5, writable: true, configurable: true });
    innerFs.append(video);
    vpPlayer.append(innerFs);

    const plyr = document.createElement("div");
    plyr.className = "plyr";
    const plyrVideo = document.createElement("video");
    const plyrControls = document.createElement("div");
    plyrControls.className = "plyr__controls";
    const plyrFs = document.createElement("button");
    plyrFs.setAttribute("data-plyr", "fullscreen");
    plyrControls.append(plyrFs);
    plyr.append(plyrVideo, plyrControls);

    document.body.append(vpPlayer, plyr);

    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "html5",
      discoverDetailedFn: async (v) => v === video
        ? {
          status: "ready",
          track: {
            platform: "html5",
            videoKey: "fs:test",
            sourceLanguage: "en",
            isAsr: false,
            hasManualTarget: true,
            cues: [{ startTime: 1, endTime: 3, text: "Fullscreen line.", translatedText: "全屏字幕。" }],
          },
        }
        : { track: null, status: "no_subtitles" },
    });

    await manager.start();
    await flushAsync();

    // Plyr player gets inline icon-only calm button right before [data-plyr="fullscreen"] even with no subtitles yet.
    const plyrToggle = plyrControls.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(plyrToggle).not.toBeNull();
    expect(plyrToggle.nextElementSibling).toBe(plyrFs);
    expect(plyrToggle.dataset.pagelingoSubMode).toBe("idle");
    expect(plyrToggle.textContent).toBe("");
    expect(plyrToggle.querySelector(".pagelingo-sub-toggle-icon")).not.toBeNull();

    // Before fullscreen: overlay host and floating toggle live inside .vp-player.
    const host = vpPlayer.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const floatingToggle = vpPlayer.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(host.parentElement).toBe(vpPlayer);
    expect(floatingToggle.parentElement).toBe(vpPlayer);

    // Enter fullscreen on innerFs (descendant of vpPlayer): overlay and floating button reparent into innerFs.
    Object.defineProperty(document, "fullscreenElement", { value: innerFs, configurable: true });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.parentElement).toBe(innerFs);
    expect(innerFs.querySelector('[data-flt-generated="video-subtitle-control"]')).not.toBeNull();

    // Exit fullscreen: overlay and floating button restore cleanly back to vpPlayer.
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.parentElement).toBe(vpPlayer);
    expect(vpPlayer.querySelector('[data-flt-generated="video-subtitle-control"]')?.parentElement).toBe(vpPlayer);

    manager.dispose();
  });
});

describe("Firefox Xray compartment safety, brand P icon, calm no-subtitle UX, and AiSubtitleProvider hook", () => {
  const XRAY_BLOCKED_ARRAY_METHODS = new Set([
    "find",
    "filter",
    "map",
    "forEach",
    "some",
    "every",
    "reduce",
    "reduceRight",
    "flatMap",
  ]);

  /** Emulates Firefox SpiderMonkey Xray behavior: calling page-compartment Array methods with content-script closures throws. */
  function makeFirefoxPageArrayProxy<T>(items: T[]): T[] {
    return new Proxy(items, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && XRAY_BLOCKED_ARRAY_METHODS.has(prop)) {
          return () => {
            throw new Error("Permission denied to access object");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  it("extracts Bilibili cid from Firefox wrappedJSObject.__INITIAL_STATE__.videoData.pages without invoking page Array.prototype.find", async () => {
    const prevWrapped = (window as unknown as { wrappedJSObject?: unknown }).wrappedJSObject;
    Object.defineProperty(window, "wrappedJSObject", {
      value: {
        __INITIAL_STATE__: {
          videoData: {
            bvid: "BV1XRAYTEST9",
            aid: 987654,
            cid: 98765401,
            pages: makeFirefoxPageArrayProxy([
              { page: 1, cid: 98765401 },
              { page: 2, cid: 98765402 },
            ]),
          },
        },
      },
      configurable: true,
    });

    try {
      const requestedUrls: string[] = [];
      const result = await discoverBilibiliSubtitleDetailed(
        {
          targetLanguage: "zh-Hans",
          preferManualCaptions: true,
          filterSoundEffects: true,
          mergeAsrSegments: false,
        },
        {
          href: "https://www.bilibili.com/video/BV1XRAYTEST9/?p=2",
          doc: document,
          fetchText: async (url: string) => {
            requestedUrls.push(url);
            if (url === "https://api.bilibili.com/x/web-interface/nav") {
              return JSON.stringify({
                code: 0,
                data: {
                  wbi_img: {
                    img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
                    sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
                  },
                },
              });
            }
            if (url.startsWith("https://api.bilibili.com/x/player/wbi/v2?")) {
              const parsed = new URL(url);
              expect(parsed.searchParams.get("bvid")).toBe("BV1XRAYTEST9");
              expect(parsed.searchParams.get("cid")).toBe("98765402");
              return JSON.stringify({
                code: 0,
                data: {
                  login_mid: 888,
                  subtitle: {
                    subtitles: [
                      { lan: "en-US", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/98765402.json" },
                    ],
                  },
                },
              });
            }
            if (url === "https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/98765402.json") {
              return JSON.stringify({
                body: [{ from: 0.5, to: 2.5, content: "Xray safe Bilibili subtitle." }],
              });
            }
            throw new Error(`Unexpected URL: ${url}`);
          },
        },
      );

      expect(result.status).toBe("ready");
      expect(result.track?.cues).toEqual([{ startTime: 0.5, endTime: 2.5, text: "Xray safe Bilibili subtitle." }]);
      // Resolved cid straight from window.__INITIAL_STATE__ without needing /x/web-interface/view!
      expect(requestedUrls.some((u) => u.includes("/x/web-interface/view"))).toBe(false);
    } finally {
      if (prevWrapped === undefined) {
        delete (window as unknown as { wrappedJSObject?: unknown }).wrappedJSObject;
      } else {
        Object.defineProperty(window, "wrappedJSObject", { value: prevWrapped, configurable: true });
      }
    }
  });

  it("extracts YouTube captionTracks from Firefox wrappedJSObject.getPlayerResponse() without invoking page Array methods", async () => {
    const moviePlayer = document.createElement("div");
    moviePlayer.id = "movie_player";
    Object.defineProperty(moviePlayer, "wrappedJSObject", {
      value: {
        getPlayerResponse: () => ({
          videoDetails: { videoId: "XRAYYT12345" },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: makeFirefoxPageArrayProxy([
                {
                  languageCode: "en",
                  vssId: ".en",
                  baseUrl: "https://www.youtube.com/api/timedtext?v=XRAYYT12345&lang=en",
                },
              ]),
            },
          },
        }),
      },
      configurable: true,
    });
    document.body.append(moviePlayer);

    const result = await discoverYouTubeSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: false },
      {
        href: "https://www.youtube.com/watch?v=XRAYYT12345",
        doc: document,
        resourceUrls: [],
        fetchText: async () => JSON.stringify({
          events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "Xray safe YouTube caption." }] }],
        }),
      },
    );

    expect(result.status).toBe("ready");
    expect(result.track?.cues).toEqual([{ startTime: 1, endTime: 3, text: "Xray safe YouTube caption." }]);
  });

  it("handles Bilibili empty subtitle_url entries cleanly and recovers from player-loaded hdslb resource URLs", async () => {
    const needLoginResult = await discoverBilibiliSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: true },
      {
        href: "https://www.bilibili.com/video/BV1EMPTYURL1?cid=44401",
        doc: document,
        resourceUrls: [],
        fetchText: async (url: string) => {
          if (url === "https://api.bilibili.com/x/web-interface/nav") return "{}";
          return JSON.stringify({
            code: 0,
            data: {
              login_mid: 0,
              need_login_subtitle: true,
              subtitle: { subtitles: [{ lan: "ai-en", subtitle_url: "" }] },
            },
          });
        },
      },
    );
    expect(needLoginResult).toEqual({ track: null, status: "need_login" });

    const recoveredResult = await discoverBilibiliSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: false },
      {
        href: "https://www.bilibili.com/video/BV1RESFALL1?cid=44402",
        doc: document,
        resourceUrls: ["https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/99944402.json?auth_key=abc"],
        fetchText: async (url: string) => {
          if (url.includes("aisubtitle.hdslb.com")) {
            return JSON.stringify({ body: [{ from: 2.0, to: 4.0, content: "Recovered from player resource." }] });
          }
          throw new Error("API temporarily unavailable");
        },
      },
    );
    expect(recoveredResult.status).toBe("ready");
    expect(recoveredResult.track?.cues).toEqual([
      { startTime: 2.0, endTime: 4.0, text: "Recovered from player resource." },
    ]);
  });

  it("renders PageLingo P icon image when browser.runtime.getURL exists and stays calm (no retry/error text) when uncaptioned or errored", async () => {
    const prevBrowser = (globalThis as { browser?: unknown }).browser;
    (globalThis as { browser?: unknown }).browser = {
      runtime: {
        getURL: (path: string) => `moz-extension://test-uuid/${path}`,
      },
    };

    try {
      const videoArea = document.createElement("div");
      videoArea.className = "bpx-player-video-area";
      const video = document.createElement("video");
      const bottomRight = document.createElement("div");
      bottomRight.className = "bpx-player-control-bottom-right";
      videoArea.append(video, bottomRight);
      document.body.append(videoArea);

      const manager = new VideoSubtitleManager({
        doc: document,
        loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true }),
        platformFn: () => "bilibili",
        discoverDetailedFn: async () => ({ track: null, status: "error" }),
      });

      await manager.start();
      await flushAsync();

      const toggleBtn = bottomRight.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
      expect(toggleBtn).not.toBeNull();
      const iconImg = toggleBtn.querySelector<HTMLImageElement>("img.pagelingo-sub-toggle-icon")!;
      expect(iconImg).not.toBeNull();
      expect(iconImg.src).toBe("moz-extension://test-uuid/icons/pagelingo-32.png");
      expect(toggleBtn.dataset.pagelingoSubMode).toBe("idle");
      expect(toggleBtn.textContent).toBe("");
      expect(toggleBtn.title).not.toContain("失败");
      expect(toggleBtn.title).not.toContain("重试");

      manager.dispose();
    } finally {
      if (prevBrowser === undefined) {
        delete (globalThis as { browser?: unknown }).browser;
      } else {
        (globalThis as { browser?: unknown }).browser = prevBrowser;
      }
    }
  });

  it("exposes AiSubtitleProvider hook when no soft subtitles exist and translates generated cues on click", async () => {
    const videoArea = document.createElement("div");
    videoArea.className = "bpx-player-video-area";
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 1.5, writable: true, configurable: true });
    const bottomRight = document.createElement("div");
    bottomRight.className = "bpx-player-control-bottom-right";
    videoArea.append(video, bottomRight);
    document.body.append(videoArea);

    const aiRequests: AiSubtitleRequest[] = [];
    registerAiSubtitleProvider({
      id: "mock-asr",
      label: "Local Whisper ASR",
      isAvailable: () => true,
      generateTrack: async (request) => {
        aiRequests.push(request);
        return {
          platform: request.platform,
          videoKey: "ai:mock-asr:1",
          sourceLanguage: "en",
          isAsr: true,
          hasManualTarget: false,
          cues: [{ startTime: 1.0, endTime: 3.5, text: "Generated by AI speech recognition." }],
        };
      },
    });

    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "bilibili",
      discoverDetailedFn: async () => ({ track: null, status: "no_subtitles" }),
      provider: {
        translateHtml: async (req) => req.html.replace("Generated by AI speech recognition.", "由 AI 语音识别生成的字幕。"),
      },
    });

    await manager.start();
    await flushAsync();

    const toggleBtn = bottomRight.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("ai-ready");
    expect(toggleBtn.textContent).toBe("AI字幕");

    // Clicking invokes the registered AiSubtitleProvider and feeds its cues straight into the overlay pipeline.
    toggleBtn.click();
    await flushAsync();

    expect(aiRequests).toHaveLength(1);
    expect(aiRequests[0]?.platform).toBe("bilibili");
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(toggleBtn.textContent).toBe("双语");

    const host = videoArea.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const srcEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-source")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(srcEl.textContent).toBe("Generated by AI speech recognition.");
    expect(transEl.textContent).toBe("由 AI 语音识别生成的字幕。");

    manager.dispose();
  });

  it("aligns Shadow DOM overlay and floating toggle button tightly to the <video> rect inside an oversized HTML5 page wrapper", async () => {
    const pageWrapper = document.createElement("div");
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 2.0, writable: true, configurable: true });
    pageWrapper.append(video);
    document.body.append(pageWrapper);

    // Oversized wrapper (e.g. simpl.info/track #container): 800x1600, while <video> sits at (40, 120) sized 640x360.
    pageWrapper.getBoundingClientRect = () => ({
      top: 0, left: 0, right: 800, bottom: 1600, width: 800, height: 1600, x: 0, y: 0, toJSON: () => ({}),
    });
    video.getBoundingClientRect = () => ({
      top: 120, left: 40, right: 680, bottom: 480, width: 640, height: 360, x: 40, y: 120, toJSON: () => ({}),
    });

    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "html5",
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "html5",
          videoKey: "html5:bounds-test",
          sourceLanguage: "en",
          isAsr: false,
          hasManualTarget: true,
          cues: [{ startTime: 1, endTime: 4, text: "Aligned on video.", translatedText: "精准贴合视频画面。" }],
        },
      }),
    });

    await manager.start();
    await flushAsync();

    const host = pageWrapper.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const toggleBtn = pageWrapper.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(host.style.getPropertyValue("--pl-host-top")).toBe("120px");
    expect(host.style.getPropertyValue("--pl-host-left")).toBe("40px");
    expect(host.style.getPropertyValue("--pl-host-width")).toBe("640px");
    expect(host.style.getPropertyValue("--pl-host-height")).toBe("360px");
    expect(toggleBtn.style.getPropertyValue("--pl-float-top")).toBe("130px");
    expect(toggleBtn.style.getPropertyValue("--pl-float-right")).toBe("130px");

    manager.dispose();
  });

  it("prefers default and English tracks over alphabetically earlier tracks (e.g. af/ar) on multi-language HTML5 videos", async () => {
    const video = document.createElement("video");
    const tracks: Array<{ lang: string; src: string; isDefault?: boolean }> = [
      { lang: "af", src: "https://cdn.example.com/af.vtt" },
      { lang: "ar", src: "https://cdn.example.com/ar.vtt" },
      { lang: "en", src: "https://cdn.example.com/en.vtt" },
      { lang: "es", src: "https://cdn.example.com/es.vtt" },
    ];
    for (const spec of tracks) {
      const el = document.createElement("track");
      el.kind = "subtitles";
      el.srclang = spec.lang;
      el.src = spec.src;
      if (spec.isDefault) el.default = true;
      video.append(el);
    }
    document.body.append(video);

    const pickedUrls: string[] = [];
    const result = await discoverHtml5Subtitle(
      video,
      { targetLanguage: "zh-Hans", preferManualCaptions: false, filterSoundEffects: true, mergeAsrSegments: false },
      {
        fetchText: async (url) => {
          pickedUrls.push(url);
          return "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nEnglish source caption.\n";
        },
      },
    );

    expect(pickedUrls).toEqual(["https://cdn.example.com/en.vtt"]);
    expect(result?.sourceLanguage).toBe("en");
    expect(result?.cues).toEqual([{ startTime: 1, endTime: 3, text: "English source caption." }]);
  });
});

describe("video subtitle translating indicator and transient failure cooldown retries", () => {
  it("shows a lightweight translating status only for pending active cues and clears it once translated", async () => {
    const container = document.createElement("div");
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 1.5, writable: true, configurable: true });
    container.append(video);
    document.body.append(container);

    const pendingResolvers = new Map<string, (html: string) => void>();
    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "html5",
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "html5",
          videoKey: "status:test",
          sourceLanguage: "en",
          isAsr: false,
          hasManualTarget: false,
          cues: [
            { startTime: 1, endTime: 3, text: "First active cue." },
            { startTime: 4, endTime: 6, text: "Second lookahead cue." },
          ],
        },
      }),
      provider: {
        translateHtml: (req) => new Promise<string>((resolve) => {
          pendingResolvers.set(req.html, resolve);
        }),
      },
    });

    await manager.start();
    await flushAsync();

    const host = container.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const statusEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-status")!;
    const srcEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-source")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    const toggleBtn = container.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;

    // While active cue 0 is in flight: subtle status indicator is visible and toggle badge marks translating.
    expect(srcEl.textContent).toBe("First active cue.");
    expect(transEl.hidden).toBe(true);
    expect(statusEl.hidden).toBe(false);
    expect(statusEl.dataset.status).toBe("translating");
    expect(statusEl.textContent).toBe("翻译中…");
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(toggleBtn.dataset.pagelingoSubTranslating).toBe("true");
    expect(toggleBtn.title).toContain("正在翻译字幕");

    // Resolve ONLY cue 0 while cue 1 remains in flight in the background lookahead window:
    // active cue 0 hides the overlay status immediately while the button still quietly indicates background work.
    pendingResolvers.get("First active cue.")?.("第一条活跃字幕。");
    await flushAsync();

    expect(transEl.hidden).toBe(false);
    expect(transEl.textContent).toBe("第一条活跃字幕。");
    expect(statusEl.hidden).toBe(true);
    expect(toggleBtn.dataset.pagelingoSubTranslating).toBe("true");

    // Switching to translation-only on cue 1 (still in flight) keeps source fallback + translating hint.
    video.currentTime = 4.5;
    video.dispatchEvent(new Event("timeupdate"));
    toggleBtn.click(); // bilingual -> translation
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("translation");
    expect(transEl.textContent).toBe("Second lookahead cue.");
    expect(statusEl.hidden).toBe(false);
    expect(statusEl.textContent).toBe("翻译中…");

    // Once cue 1 resolves, both status indicator and toggle translating flag clear.
    pendingResolvers.get("Second lookahead cue.")?.("第二条预译字幕。");
    await flushAsync();

    expect(transEl.textContent).toBe("第二条预译字幕。");
    expect(statusEl.hidden).toBe(true);
    expect(toggleBtn.dataset.pagelingoSubTranslating).toBe("false");

    manager.dispose();
  });

  it("retries transient cue translation failures after cooldown without needing timeupdate", async () => {
    const container = document.createElement("div");
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 1.5, writable: true, configurable: true });
    container.append(video);
    document.body.append(container);

    let attempts = 0;
    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "html5",
      retryDelaysMs: [25, 35],
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "html5",
          videoKey: "retry:transient",
          sourceLanguage: "en",
          isAsr: false,
          hasManualTarget: false,
          cues: [{ startTime: 1, endTime: 4, text: "Transient flaky line." }],
        },
      }),
      provider: {
        translateHtml: async () => {
          attempts += 1;
          if (attempts <= 2) throw new Error("HTTP 429 rate limited");
          return "冷却重试成功后的字幕。";
        },
      },
    });

    await manager.start();
    await flushAsync();

    const host = container.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const statusEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-status")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;

    // Attempt 1 failed -> in cooldown window, timeupdate must NOT spam immediate retries.
    expect(attempts).toBe(1);
    expect(statusEl.hidden).toBe(false);
    expect(statusEl.dataset.status).toBe("retrying");
    expect(statusEl.textContent).toBe("重试翻译中…");
    video.dispatchEvent(new Event("timeupdate"));
    expect(attempts).toBe(1);

    // Wait across both cooldowns without dispatching timeupdate (simulates paused video):
    // attempt 2 fails -> attempt 3 succeeds automatically!
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(attempts).toBe(3);
    expect(transEl.textContent).toBe("冷却重试成功后的字幕。");
    expect(statusEl.hidden).toBe(true);
    manager.dispose();
  });

  it("caps automatic retries on persistent failures and lets toggling off -> bilingual re-attempt", async () => {
    const capContainer = document.createElement("div");
    const capVideo = document.createElement("video");
    Object.defineProperty(capVideo, "currentTime", { value: 1.5, writable: true, configurable: true });
    capContainer.append(capVideo);
    document.body.append(capContainer);

    let capAttempts = 0;
    let shouldSucceed = false;
    const capManager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "html5",
      retryDelaysMs: [15],
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "html5",
          videoKey: "retry:cap",
          sourceLanguage: "en",
          isAsr: false,
          hasManualTarget: false,
          cues: [{ startTime: 1, endTime: 4, text: "Always fails until toggled." }],
        },
      }),
      provider: {
        translateHtml: async () => {
          capAttempts += 1;
          if (!shouldSucceed) throw new Error("Network timeout");
          return "手动重开后恢复的字幕。";
        },
      },
    });

    await capManager.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    // Initial attempt + 1 configured retry = 2 total, then stops quietly.
    expect(capAttempts).toBe(2);
    const capHost = capContainer.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const capStatus = capHost.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-status")!;
    const capTrans = capHost.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(capStatus.hidden).toBe(true);

    const capToggle = capContainer.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    shouldSucceed = true;
    capToggle.click(); // bilingual -> translation
    capToggle.click(); // translation -> off
    capToggle.click(); // off -> bilingual (clears non-fatal failures and retries)
    await flushAsync();
    expect(capAttempts).toBe(3);
    expect(capTrans.textContent).toBe("手动重开后恢复的字幕。");
    capManager.dispose();
  });

  it("does not schedule automatic retries on fatal auth/config errors", async () => {
    const fatalContainer = document.createElement("div");
    const fatalVideo = document.createElement("video");
    Object.defineProperty(fatalVideo, "currentTime", { value: 1.5, writable: true, configurable: true });
    fatalContainer.append(fatalVideo);
    document.body.append(fatalContainer);

    let fatalAttempts = 0;
    const fatalManager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "html5",
      retryDelaysMs: [15],
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "html5",
          videoKey: "retry:fatal",
          sourceLanguage: "en",
          isAsr: false,
          hasManualTarget: false,
          cues: [{ startTime: 1, endTime: 4, text: "Needs valid API key." }],
        },
      }),
      provider: {
        translateHtml: async () => {
          fatalAttempts += 1;
          throw new Error("翻译服务请求失败：HTTP 401");
        },
      },
    });

    await fatalManager.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fatalAttempts).toBe(1);
    const fatalHost = fatalContainer.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    expect(fatalHost.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-status")!.hidden).toBe(true);
    fatalManager.dispose();
  });

  it("retries transient failures for YouTube live DOM captions after cooldown", async () => {
    const moviePlayer = document.createElement("div");
    moviePlayer.id = "movie_player";
    moviePlayer.className = "html5-video-player";
    const video = document.createElement("video");
    const captionContainer = document.createElement("div");
    captionContainer.className = "ytp-caption-window-container";
    const seg = document.createElement("span");
    seg.className = "ytp-caption-segment";
    seg.textContent = "Live caption after transient hiccup.";
    captionContainer.append(seg);
    moviePlayer.append(video, captionContainer);
    document.body.append(moviePlayer);

    let attempts = 0;
    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, showPlayerButton: true, displayMode: "bilingual" }),
      platformFn: () => "youtube",
      detectLanguageFn: async () => "en",
      retryDelaysMs: [20],
      discoverDetailedFn: async () => ({ track: null, status: "need_cc" }),
      provider: {
        translateHtml: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Temporary network glitch");
          return "瞬时波动后重试成功的实时字幕。";
        },
      },
    });

    await manager.start();
    await flushAsync();

    const host = moviePlayer.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const statusEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-status")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(attempts).toBe(1);
    expect(statusEl.hidden).toBe(false);
    expect(statusEl.dataset.status).toBe("retrying");

    await new Promise((resolve) => setTimeout(resolve, 65));
    expect(attempts).toBe(2);
    expect(transEl.textContent).toBe("瞬时波动后重试成功的实时字幕。");
    expect(statusEl.hidden).toBe(true);

    manager.dispose();
  });
});

describe("manual-start default, same-language fallback bilingual, and missing language pack hints", () => {
  it("stays calmly off by default (autoStart: false), respects configured default displayMode on first click, and never locks out the quick button", async () => {
    const videoArea = document.createElement("div");
    videoArea.className = "bpx-player-video-area";
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 2.0, writable: true, configurable: true });
    const bottomRight = document.createElement("div");
    bottomRight.className = "bpx-player-control-bottom-right";
    videoArea.append(video, bottomRight);
    document.body.append(videoArea);

    const calls: TranslationRequest[] = [];
    const manager = new VideoSubtitleManager({
      doc: document,
      // Default autoStart is false; even if showPlayerButton is false, manual mode keeps the quick button visible.
      loadSettingsFn: async () => makeSettings({ enabled: true, showPlayerButton: false, displayMode: "translation" }),
      platformFn: () => "bilibili",
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "bilibili",
          videoKey: "bili:BV1manual:1001:en",
          sourceLanguage: "en",
          isAsr: false,
          hasManualTarget: false,
          cues: [{ startTime: 1, endTime: 4, text: "Click button to open." }],
        },
      }),
      provider: {
        translateHtml: async (req) => {
          calls.push(req);
          return req.html.replace("Click button to open.", "点击按钮后再开启。");
        },
      },
    });

    await manager.start();
    await flushAsync();

    // Initially off: zero translation calls, overlay hidden, native captions untouched, calm grayscale button mounted.
    expect(calls).toHaveLength(0);
    expect(videoArea.hasAttribute("data-pagelingo-subtitle-active")).toBe(false);
    const host = videoArea.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const wrap = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-wrap")!;
    const srcEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-source")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(wrap.hidden).toBe(true);

    const toggleBtn = bottomRight.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("off");
    expect(toggleBtn.textContent).toBe("");
    expect(toggleBtn.title).toContain("点击开启仅译文");

    // Click 1 enters configured default ("translation") first, then Click 2 -> "bilingual", Click 3 -> "off".
    toggleBtn.click();
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("translation");
    expect(toggleBtn.title).toContain("点击切换为双语对照");
    expect(wrap.hidden).toBe(false);
    expect(srcEl.hidden).toBe(true);
    expect(transEl.textContent).toBe("点击按钮后再开启。");

    toggleBtn.click();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(toggleBtn.title).toContain("点击关闭");
    expect(srcEl.hidden).toBe(false);
    expect(srcEl.textContent).toBe("Click button to open.");
    expect(transEl.textContent).toBe("点击按钮后再开启。");

    toggleBtn.click();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("off");
    expect(wrap.hidden).toBe(true);
    expect(videoArea.hasAttribute("data-pagelingo-subtitle-active")).toBe(false);

    manager.dispose();
  });

  it("activates YouTube need_cc in one click when autoStart is false", async () => {
    const moviePlayer = document.createElement("div");
    moviePlayer.id = "movie_player";
    moviePlayer.className = "html5-video-player";
    const video = document.createElement("video");
    const controls = document.createElement("div");
    controls.className = "ytp-right-controls";
    const ccBtn = document.createElement("button");
    ccBtn.className = "ytp-subtitles-button";
    ccBtn.setAttribute("aria-pressed", "false");
    controls.append(ccBtn);
    const captionContainer = document.createElement("div");
    captionContainer.className = "ytp-caption-window-container";
    moviePlayer.append(video, captionContainer, controls);
    document.body.append(moviePlayer);

    ccBtn.addEventListener("click", () => {
      ccBtn.setAttribute("aria-pressed", "true");
      const seg = document.createElement("span");
      seg.className = "ytp-caption-segment";
      seg.textContent = "One click CC activation.";
      captionContainer.replaceChildren(seg);
    });

    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: false, displayMode: "bilingual" }),
      platformFn: () => "youtube",
      detectLanguageFn: async () => "en",
      discoverDetailedFn: async () => ({ track: null, status: "need_cc" }),
      provider: {
        translateHtml: async (req) => req.html.replace("One click CC activation.", "一键开启 CC 并显示双语。"),
      },
    });

    await manager.start();
    await flushAsync();

    // Calm off icon initially (not loud 开CC badge when autoStart is false).
    const toggleBtn = controls.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("off");
    expect(toggleBtn.textContent).toBe("");

    // One click turns on CC AND shows bilingual immediately.
    toggleBtn.click();
    await flushAsync();
    expect(ccBtn.getAttribute("aria-pressed")).toBe("true");
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    const host = moviePlayer.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    expect(host.shadowRoot!.querySelector(".pl-sub-source")!.textContent).toBe("One click CC activation.");
    expect(host.shadowRoot!.querySelector(".pl-sub-translation")!.textContent).toBe("一键开启 CC 并显示双语。");

    manager.dispose();
  });

  it("keeps same-language Bilibili ai-zh videos silent even with autoStart: true and translates zh-Hans -> en bilingual on manual click", async () => {
    const videoArea = document.createElement("div");
    videoArea.className = "bpx-player-video-area";
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 11.0, writable: true, configurable: true });
    const bottomRight = document.createElement("div");
    bottomRight.className = "bpx-player-control-bottom-right";
    videoArea.append(video, bottomRight);
    document.body.append(videoArea);

    const calls: TranslationRequest[] = [];
    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, displayMode: "bilingual" }, "translation", "zh-Hans"),
      platformFn: () => "bilibili",
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "bilibili",
          videoKey: "bili:BV1D74B6bESZ:43376117699:ai-zh",
          sourceLanguage: "zh-Hans",
          isAsr: true,
          hasManualTarget: false,
          cues: [{ startTime: 10, endTime: 14, text: "可能接线确实是没有接好的" }],
        },
      }),
      provider: {
        translateHtml: async (req) => {
          calls.push(req);
          return req.html.replace("可能接线确实是没有接好的", "Maybe the wiring really wasn't connected well.");
        },
      },
    });

    await manager.start();
    await flushAsync();

    // Even with autoStart: true, same-language Chinese video must NOT auto-overlay single-language subtitles.
    expect(calls).toHaveLength(0);
    expect(videoArea.hasAttribute("data-pagelingo-subtitle-active")).toBe(false);
    const host = videoArea.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const wrap = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-wrap")!;
    const srcEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-source")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(wrap.hidden).toBe(true);

    const toggleBtn = bottomRight.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("off");
    expect(toggleBtn.title).toContain("译为 English 开启双语");

    // Manual click activates default bilingual mode by translating zh-Hans -> en!
    toggleBtn.click();
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sourceLanguage).toBe("zh-Hans");
    expect(calls[0]?.targetLanguage).toBe("en");
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(toggleBtn.title).toContain("译为 English");
    expect(wrap.hidden).toBe(false);
    expect(srcEl.hidden).toBe(false);
    expect(srcEl.textContent).toBe("可能接线确实是没有接好的");
    expect(transEl.hidden).toBe(false);
    expect(transEl.textContent).toBe("Maybe the wiring really wasn't connected well.");

    // Next click -> translation-only (English), next click -> off.
    toggleBtn.click();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("translation");
    expect(srcEl.hidden).toBe(true);
    expect(transEl.textContent).toBe("Maybe the wiring really wasn't connected well.");

    toggleBtn.click();
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("off");
    expect(wrap.hidden).toBe(true);

    manager.dispose();
  });

  it("does not pre-copy target-language manual captions onto translatedText in Bilibili discovery so manual click can translate zh-Hans -> en", async () => {
    const result = await discoverBilibiliSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: false },
      {
        href: "https://www.bilibili.com/video/BV1onlyzh123/?cid=9988",
        fetchText: async (url) => {
          if (url.includes("/x/web-interface/nav")) return JSON.stringify({ code: 0, data: {} });
          if (url.includes("/x/player/wbi/v2")) {
            return JSON.stringify({
              code: 0,
              data: {
                subtitle: {
                  subtitles: [{ lan: "zh-CN", subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/only-zh.json", type: 0 }],
                },
              },
            });
          }
          if (url.includes("only-zh.json")) {
            return JSON.stringify({ body: [{ from: 1, to: 3, content: "纯中文人工字幕" }] });
          }
          throw new Error(`Unexpected URL: ${url}`);
        },
      },
    );

    expect(result.status).toBe("ready");
    expect(result.track?.sourceLanguage).toBe("zh-Hans");
    expect(result.track?.hasManualTarget).toBe(false);
    expect(result.track?.cues[0]?.text).toBe("纯中文人工字幕");
    expect(result.track?.cues[0]?.translatedText).toBeUndefined();
  });

  it("falls back to zh-Hans on manual click when targetLanguage is en and video only has English subtitles", async () => {
    const container = document.createElement("div");
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 2.0, writable: true, configurable: true });
    container.append(video);
    document.body.append(container);

    const calls: TranslationRequest[] = [];
    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, displayMode: "bilingual" }, "translation", "en"),
      platformFn: () => "html5",
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "html5",
          videoKey: "html5:en-only",
          sourceLanguage: "en",
          isAsr: false,
          hasManualTarget: false,
          cues: [{ startTime: 1, endTime: 4, text: "English only caption." }],
        },
      }),
      provider: {
        translateHtml: async (req) => {
          calls.push(req);
          return req.html.replace("English only caption.", "纯英文字幕的中文译文。");
        },
      },
    });

    await manager.start();
    await flushAsync();
    expect(calls).toHaveLength(0);

    const toggleBtn = container.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("off");
    expect(toggleBtn.title).toContain("简体中文");

    toggleBtn.click();
    await flushAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sourceLanguage).toBe("en");
    expect(calls[0]?.targetLanguage).toBe("zh-Hans");

    manager.dispose();
  });

  it("shows an actionable missing-pack indicator without retrying when local Bergamot lacks the direction, and recovers on manual reopen", async () => {
    const container = document.createElement("div");
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 2.0, writable: true, configurable: true });
    container.append(video);
    document.body.append(container);

    let attempts = 0;
    let packInstalled = false;
    const manager = new VideoSubtitleManager({
      doc: document,
      loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: false, displayMode: "bilingual" }, "translation", "zh-Hans"),
      platformFn: () => "html5",
      retryDelaysMs: [15],
      discoverDetailedFn: async () => ({
        status: "ready",
        track: {
          platform: "html5",
          videoKey: "html5:zh-missing-pack",
          sourceLanguage: "zh-Hans",
          isAsr: false,
          hasManualTarget: false,
          cues: [{ startTime: 1, endTime: 4, text: "需要反向语言包的中文句子" }],
        },
      }),
      provider: {
        translateHtml: async () => {
          attempts += 1;
          if (!packInstalled) throw new Error("当前本地模型不支持 简体中文 → English");
          return "Chinese sentence translated after installing reverse pack.";
        },
      },
    });

    await manager.start();
    await flushAsync();

    const toggleBtn = container.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    toggleBtn.click(); // off -> bilingual (triggers zh-Hans -> en)
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(attempts).toBe(1); // Fatal missing-pack error does NOT spam auto-retries.
    const host = container.querySelector<HTMLDivElement>('[data-flt-generated="video-subtitle"]')!;
    const statusEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-status")!;
    const transEl = host.shadowRoot!.querySelector<HTMLDivElement>(".pl-sub-translation")!;
    expect(statusEl.hidden).toBe(false);
    expect(statusEl.dataset.status).toBe("missing-pack");
    expect(statusEl.textContent).toContain("简体中文 → English");

    // After installing reverse pack or switching engine, toggling off -> bilingual re-attempts cleanly.
    packInstalled = true;
    toggleBtn.click(); // bilingual -> translation
    toggleBtn.click(); // translation -> off
    toggleBtn.click(); // off -> bilingual
    await flushAsync();

    expect(attempts).toBe(2);
    expect(statusEl.hidden).toBe(true);
    expect(transEl.textContent).toBe("Chinese sentence translated after installing reverse pack.");

    manager.dispose();
  });
});

describe("multi-language YouTube and Bilibili original source track ranking", () => {
  it("picks English over alphabetically earlier Arabic on multi-language YouTube videos (e.g. trailers with ar/de/en/zh-Hans)", async () => {
    const moviePlayer = document.createElement("div");
    moviePlayer.id = "movie_player";
    const ytResponse = {
      videoDetails: { videoId: "CXsSTUHr8ww", title: "Grand Theft Auto VI Trailer 2" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: "https://www.youtube.com/api/timedtext?v=CXsSTUHr8ww&lang=ar", languageCode: "ar", vssId: ".ar", name: { simpleText: "Arabic" } },
            { baseUrl: "https://www.youtube.com/api/timedtext?v=CXsSTUHr8ww&lang=de", languageCode: "de", vssId: ".de", name: { simpleText: "German" } },
            { baseUrl: "https://www.youtube.com/api/timedtext?v=CXsSTUHr8ww&lang=en", languageCode: "en", vssId: ".en", name: { simpleText: "English" } },
            { baseUrl: "https://www.youtube.com/api/timedtext?v=CXsSTUHr8ww&lang=zh-Hans", languageCode: "zh-Hans", vssId: ".zh-Hans", name: { simpleText: "Chinese (Simplified)" } },
          ],
        },
      },
    };
    Object.defineProperty(moviePlayer, "getPlayerResponse", { value: () => ytResponse, configurable: true });
    document.body.append(moviePlayer);

    const fetchedLangs: string[] = [];
    const result = await discoverYouTubeSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: true },
      {
        href: "https://www.youtube.com/watch?v=CXsSTUHr8ww",
        doc: document,
        resourceUrls: [],
        fetchText: async (url) => {
          const lang = new URL(url).searchParams.get("lang") ?? "";
          fetchedLangs.push(lang);
          if (lang === "en") {
            return JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "We're gonna get to Cal, jump on that boat and disappear." }] }] });
          }
          if (lang === "zh-Hans") {
            return JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "好的。我们会上车，上船，然后消失。" }] }] });
          }
          return JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "حسناً. سنصل للسيارة" }] }] });
        },
      },
    );

    expect(result.status).toBe("ready");
    expect(result.track?.sourceLanguage).toBe("en");
    expect(result.track?.hasManualTarget).toBe(true);
    expect(fetchedLangs).not.toContain("ar");
    expect(result.track?.cues[0]?.text).toBe("We're gonna get to Cal, jump on that boat and disappear.");
    expect(result.track?.cues[0]?.translatedText).toBe("好的。我们会上车，上船，然后消失。");
  });

  it("prefers spoken ASR original language (a.en) over unrelated community manual captions (ar), and respects audioTracks/title for non-English videos (ja/es) safely under Xray proxies", async () => {
    // Case 1: English video with a.en ASR + community manual ar -> picks a.en (en), not ar.
    const moviePlayer = document.createElement("div");
    moviePlayer.id = "movie_player";
    const enAsrResponse = {
      videoDetails: { videoId: "EN_ASR_123", title: "Deep Dive into Distributed Systems" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: "https://www.youtube.com/api/timedtext?v=EN_ASR_123&lang=ar", languageCode: "ar", vssId: ".ar" },
            { baseUrl: "https://www.youtube.com/api/timedtext?v=EN_ASR_123&lang=en&kind=asr", languageCode: "en", kind: "asr", vssId: "a.en" },
          ],
        },
      },
    };
    Object.defineProperty(moviePlayer, "getPlayerResponse", { value: () => enAsrResponse, configurable: true });
    document.body.append(moviePlayer);

    const enResult = await discoverYouTubeSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: true },
      {
        href: "https://www.youtube.com/watch?v=EN_ASR_123",
        doc: document,
        resourceUrls: [],
        fetchText: async (url) => {
          const lang = new URL(url).searchParams.get("lang");
          return JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: lang === "en" ? "Hello distributed world." : "مرحبا" }] }] });
        },
      },
    );
    expect(enResult.track?.sourceLanguage).toBe("en");
    expect(enResult.track?.cues[0]?.text).toBe("Hello distributed world.");

    // Case 2: Japanese video with [ar, en, ja, zh-Hans] and Xray-restricted audioTracks + name.runs arrays -> picks ja!
    const xrayForbidden = <T extends object>(arr: T[]) => new Proxy(arr, {
      get(target, prop, receiver) {
        if (prop === "map" || prop === "filter" || prop === "find" || prop === "some" || prop === "forEach") {
          return () => { throw new Error("Permission denied to access property"); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const jaResponse = {
      videoDetails: { videoId: "JA_VID_456", title: "【公式】新作アニメ予告" },
      captions: {
        playerCaptionsTracklistRenderer: {
          defaultAudioTrackIndex: 0,
          audioTracks: xrayForbidden([{ audioTrackId: "ja.4", defaultCaptionTrackIndex: 2 }]),
          captionTracks: xrayForbidden([
            { baseUrl: "https://www.youtube.com/api/timedtext?v=JA_VID_456&lang=ar", languageCode: "ar", vssId: ".ar", name: { runs: xrayForbidden([{ text: "Arabic" }]) } },
            { baseUrl: "https://www.youtube.com/api/timedtext?v=JA_VID_456&lang=en", languageCode: "en", vssId: ".en", name: { runs: xrayForbidden([{ text: "English" }]) } },
            { baseUrl: "https://www.youtube.com/api/timedtext?v=JA_VID_456&lang=ja", languageCode: "ja", vssId: ".ja", name: { runs: xrayForbidden([{ text: "Japanese" }]) } },
            { baseUrl: "https://www.youtube.com/api/timedtext?v=JA_VID_456&lang=zh-Hans", languageCode: "zh-Hans", vssId: ".zh-Hans" },
          ]),
        },
      },
    };
    Object.defineProperty(moviePlayer, "getPlayerResponse", { value: () => jaResponse, configurable: true });

    const jaResult = await discoverYouTubeSubtitleDetailed(
      { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: true },
      {
        href: "https://www.youtube.com/watch?v=JA_VID_456",
        doc: document,
        resourceUrls: [],
        fetchText: async (url) => {
          const lang = new URL(url).searchParams.get("lang");
          const text = lang === "ja" ? "新しい物語が始まる。" : lang === "zh-Hans" ? "新的故事开始了。" : "Wrong track";
          return JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2500, segs: [{ utf8: text }] }] });
        },
      },
    );
    expect(jaResult.track?.sourceLanguage).toBe("ja");
    expect(jaResult.track?.cues[0]?.text).toBe("新しい物語が始まる。");
    expect(jaResult.track?.cues[0]?.translatedText).toBe("新的故事开始了。");
  });

  it("picks English over alphabetically earlier Arabic on multi-language Bilibili videos with Chinese titles", async () => {
    const prevTitle = document.title;
    document.title = "【官方中字】GTA 6 第二支预告片 - 哔哩哔哩";
    try {
      const result = await discoverBilibiliSubtitleDetailed(
        { targetLanguage: "zh-Hans", preferManualCaptions: true, filterSoundEffects: true, mergeAsrSegments: false },
        {
          href: "https://www.bilibili.com/video/BV1multilang/?cid=7788",
          doc: document,
          fetchText: async (url) => {
            if (url.includes("/x/web-interface/nav")) return JSON.stringify({ code: 0, data: {} });
            if (url.includes("/x/player/wbi/v2")) {
              return JSON.stringify({
                code: 0,
                data: {
                  subtitle: {
                    subtitles: [
                      { lan: "ar", subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/ar.json", type: 0 },
                      { lan: "en-US", subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/en.json", type: 0 },
                      { lan: "zh-CN", subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/zh.json", type: 0 },
                    ],
                  },
                },
              });
            }
            if (url.includes("en.json")) return JSON.stringify({ body: [{ from: 1, to: 3, content: "Jump on that boat." }] });
            if (url.includes("zh.json")) return JSON.stringify({ body: [{ from: 1, to: 3, content: "跳上那条船。" }] });
            return JSON.stringify({ body: [{ from: 1, to: 3, content: "اركب القارب" }] });
          },
        },
      );
      expect(result.status).toBe("ready");
      expect(result.track?.sourceLanguage).toBe("en");
      expect(result.track?.cues[0]?.text).toBe("Jump on that boat.");
      expect(result.track?.cues[0]?.translatedText).toBe("跳上那条船。");
    } finally {
      document.title = prevTitle;
    }
  });

  it("skips bwp-video 200ms sync ticks while document is hidden or subtitle display mode is off", async () => {
    vi.useFakeTimers();
    const origHiddenDesc = Object.getOwnPropertyDescriptor(document, "hidden");
    let hiddenFlag = true;
    Object.defineProperty(document, "hidden", { get: () => hiddenFlag, configurable: true });
    try {
      const wrap = document.createElement("div");
      wrap.className = "bpx-player-video-wrap";
      const bwp = document.createElement("bwp-video");
      let timeReadCount = 0;
      Object.defineProperty(bwp, "currentTime", {
        get: () => {
          timeReadCount += 1;
          return 2.0;
        },
        configurable: true,
      });
      wrap.append(bwp);
      document.body.append(wrap);

      const track: DiscoveredSubtitleTrack = {
        platform: "bilibili",
        videoKey: "bili:bwp-throttle",
        sourceLanguage: "en",
        isAsr: false,
        hasManualTarget: false,
        cues: [{ startTime: 1, endTime: 4, text: "BWP polling check." }],
        restoreNativeTrack: () => {},
      };

      const manager = new VideoSubtitleManager({
        doc: document,
        loadSettingsFn: async () => makeSettings({ enabled: true, autoStart: true, displayMode: "bilingual" }),
        discoverFn: async () => track,
        platformFn: () => "bilibili",
        provider: { translateHtml: async ({ html }) => html.replace("BWP polling check.", "BWP 轮询检查。") },
      });

      await manager.start();
      await Promise.resolve();
      await Promise.resolve();

      const readsAfterStart = timeReadCount;
      // While document.hidden === true, 200ms ticks must NOT poll currentTime.
      await vi.advanceTimersByTimeAsync(1000);
      expect(timeReadCount).toBe(readsAfterStart);

      // Once visible, 200ms ticks resume cleanly.
      hiddenFlag = false;
      await vi.advanceTimersByTimeAsync(450);
      expect(timeReadCount).toBeGreaterThan(readsAfterStart);

      manager.dispose();
    } finally {
      if (origHiddenDesc) Object.defineProperty(document, "hidden", origHiddenDesc);
      else delete (document as { hidden?: boolean }).hidden;
      vi.useRealTimers();
    }
  });
});




