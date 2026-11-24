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
  getBilibiliMixinKey,
  md5Hex,
  resetBilibiliWbiCacheForTests,
  signBilibiliWbiParams,
} from "../src/video-translation/bilibili-wbi";
import { VideoSubtitleManager } from "../src/video-translation/video-subtitle-controller";

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById("pagelingo-video-subtitle-style")?.remove();
  resetBilibiliWbiCacheForTests();
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
      loadSettingsFn: async () => makeSettings({ enabled: true, showPlayerButton: true, displayMode: "bilingual" }),
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
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("need-login");
    expect(toggleBtn.textContent).toBe("PL 需登录");

    // Clicking the button in need-login state retries subtitle discovery and renders translated cue.
    toggleBtn.click();
    await flushAsync();

    expect(attempt).toBe(2);
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(toggleBtn.textContent).toBe("PL 双语");
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
      loadSettingsFn: async () => makeSettings({ enabled: true, displayMode: "bilingual" }),
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

describe("Bilibili WBI signing and subtitle discovery", () => {
  it("computes standard MD5 and matches the official Bilibili WBI reference signature vector", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("hello world")).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");

    const imgKey = "7cd084941338484aae1ad9425b84077c";
    const subKey = "4932caff0ff746eab6f01bf08b70ac45";
    expect(getBilibiliMixinKey(imgKey, subKey)).toBe("ea1db124af3c7062474693fa704f4ff8");
    expect(
      signBilibiliWbiParams({ foo: "114", bar: "514", zab: 1919810 }, imgKey, subKey, 1702204169),
    ).toBe("bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4");
  });

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

  it("ignores stale SPA __INITIAL_STATE__, resolves ?p=2 cid via view API, signs /x/player/wbi/v2, and fetches CDN subtitle with credentials omit", async () => {
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
            const u = new URL(url);
            expect(u.searchParams.get("bvid")).toBe("BV1NEWVIDEO2");
            expect(u.searchParams.get("cid")).toBe("22202");
            expect(u.searchParams.get("w_rid")).toMatch(/^[a-f0-9]{32}$/);
            expect(u.searchParams.get("wts")).toMatch(/^\d+$/);
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
      loadSettingsFn: async () => makeSettings({ enabled: true, showPlayerButton: true, displayMode: "bilingual" }),
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
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("need-cc");
    expect(toggleBtn.textContent).toBe("PL 开CC");

    // Clicking PL 开CC turns on YouTube native CC and activates live DOM caption translation.
    toggleBtn.click();
    await flushAsync();

    expect(ccClicked).toBe(1);
    expect(toggleBtn.dataset.pagelingoSubMode).toBe("bilingual");
    expect(toggleBtn.textContent).toBe("PL 双语");
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
        loadSettingsFn: async () => makeSettings({ enabled: true, showPlayerButton: true }),
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
      loadSettingsFn: async () => makeSettings({ enabled: true, showPlayerButton: true, displayMode: "bilingual" }),
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
      loadSettingsFn: async () => makeSettings({ enabled: true, showPlayerButton: true, displayMode: "bilingual" }),
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

    // Plyr player gets inline button right before [data-plyr="fullscreen"] even with no subtitles yet.
    const plyrToggle = plyrControls.querySelector<HTMLButtonElement>('[data-flt-generated="video-subtitle-control"]')!;
    expect(plyrToggle).not.toBeNull();
    expect(plyrToggle.nextElementSibling).toBe(plyrFs);
    expect(plyrToggle.textContent).toBe("PL 无字幕");

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
