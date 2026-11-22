// Platform-specific video subtitle discovery for YouTube, Bilibili, and standard HTML5 <video><track>.

import { normalizeDetectedLanguage } from "../shared/settings";
import { sendRuntimeMessage } from "../shared/runtime-message";
import {
  alignManualTargetCues,
  parseBilibiliSubtitleJson,
  parseWebVtt,
  parseYouTubeJson3,
  parseYouTubeTimedTextXml,
  prepareSubtitleCues,
  type SubtitleCue,
} from "./subtitle-cues";

export type VideoPlatform = "youtube" | "bilibili" | "html5";

export interface DiscoveredSubtitleTrack {
  platform: VideoPlatform;
  videoKey: string;
  sourceLanguage: string | null;
  isAsr: boolean;
  cues: SubtitleCue[];
  /** True when target-language manual captions were already paired (0 translation calls needed). */
  hasManualTarget: boolean;
  /** Optional cleanup when hiding native HTML5 TextTrack. */
  restoreNativeTrack?: () => void;
}

export interface DiscoverTrackOptions {
  targetLanguage: string;
  preferManualCaptions: boolean;
  filterSoundEffects: boolean;
  mergeAsrSegments: boolean;
}

export function detectVideoPlatform(hostname = location.hostname): VideoPlatform {
  const host = hostname.toLowerCase();
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") || host.endsWith(".youtube-nocookie.com")) {
    return "youtube";
  }
  if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
    return "bilibili";
  }
  return "html5";
}

async function fetchTrackText(url: string): Promise<string> {
  const absolute = new URL(url, location.href).href;
  try {
    const direct = await fetch(absolute, { credentials: "include" });
    if (direct.ok) return await direct.text();
  } catch {
    // Fall back to background proxy for cross-origin CDN tracks.
  }
  const proxied = await sendRuntimeMessage<{ ok?: boolean; text?: string; error?: string }>({
    type: "fetch-subtitle-track",
    url: absolute,
  });
  if (!proxied?.ok || typeof proxied.text !== "string") {
    throw new Error(proxied?.error ?? "无法获取视频字幕轨道");
  }
  return proxied.text;
}

/* -------------------------------------------------------------------------- */
/* YouTube Caption Track Discovery                                            */
/* -------------------------------------------------------------------------- */

interface YouTubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
}

function extractBalancedJsonObject(source: string, marker: string): string | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function extractYouTubeTracksFromPlayerResponse(response: unknown): { videoId: string; tracks: YouTubeCaptionTrack[] } | null {
  if (!response || typeof response !== "object") return null;
  const record = response as {
    videoDetails?: { videoId?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: YouTubeCaptionTrack[] } };
  };
  const videoId = typeof record.videoDetails?.videoId === "string" ? record.videoDetails.videoId : "";
  const tracks = record.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return { videoId, tracks };
}

function currentYouTubeVideoId(): string | null {
  const url = new URL(location.href);
  const v = url.searchParams.get("v");
  if (v) return v;
  const shorts = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
  return shorts?.[1] ?? null;
}

async function fetchYouTubeCaptionTracks(videoId: string): Promise<YouTubeCaptionTrack[]> {
  // 1. Fast path: inspect inline scripts in the current document when videoId matches.
  for (const script of Array.from(document.scripts)) {
    const content = script.textContent ?? "";
    if (!content.includes("captionTracks")) continue;
    const jsonText = extractBalancedJsonObject(content, "ytInitialPlayerResponse =");
    if (!jsonText) continue;
    try {
      const parsed = extractYouTubeTracksFromPlayerResponse(JSON.parse(jsonText));
      if (parsed && (!parsed.videoId || parsed.videoId === videoId)) return parsed.tracks;
    } catch {
      // Fall through to fresh watch page fetch.
    }
  }

  // 2. SPA navigation path: fetch the current watch page HTML with session cookies.
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchTrackText(watchUrl);
  const jsonText = extractBalancedJsonObject(html, "ytInitialPlayerResponse =");
  if (!jsonText) return [];
  try {
    return extractYouTubeTracksFromPlayerResponse(JSON.parse(jsonText))?.tracks ?? [];
  } catch {
    return [];
  }
}

async function loadYouTubeTrackCues(track: YouTubeCaptionTrack): Promise<SubtitleCue[]> {
  if (!track.baseUrl) return [];
  const jsonUrl = new URL(track.baseUrl, location.href);
  jsonUrl.searchParams.set("fmt", "json3");
  try {
    const raw = await fetchTrackText(jsonUrl.href);
    const parsed = parseYouTubeJson3(JSON.parse(raw));
    if (parsed.length > 0) return parsed;
  } catch {
    // Fall back to default XML timedtext format.
  }
  const xmlRaw = await fetchTrackText(track.baseUrl);
  return parseYouTubeTimedTextXml(xmlRaw);
}

async function discoverYouTubeSubtitle(options: DiscoverTrackOptions): Promise<DiscoveredSubtitleTrack | null> {
  const videoId = currentYouTubeVideoId();
  if (!videoId) return null;
  const tracks = await fetchYouTubeCaptionTracks(videoId);
  if (!tracks.length) return null;

  const targetNorm = normalizeDetectedLanguage(options.targetLanguage) ?? options.targetLanguage;
  const normalizedTracks = tracks
    .filter((t) => typeof t.baseUrl === "string" && t.baseUrl.length > 0)
    .map((track) => ({
      track,
      lang: normalizeDetectedLanguage(track.languageCode) ?? null,
      isAsr: track.kind === "asr",
    }));
  if (!normalizedTracks.length) return null;

  const manualTarget = options.preferManualCaptions
    ? normalizedTracks.find((item) => !item.isAsr && item.lang === targetNorm)
    : undefined;
  const sourceTrack =
    normalizedTracks.find((item) => !item.isAsr && item.lang !== targetNorm)
    ?? normalizedTracks.find((item) => item.isAsr && item.lang !== targetNorm)
    ?? normalizedTracks.find((item) => !item.isAsr)
    ?? normalizedTracks[0]!;

  if (manualTarget && sourceTrack === manualTarget) {
    const targetCues = prepareSubtitleCues(await loadYouTubeTrackCues(manualTarget.track), {
      filterSoundEffects: options.filterSoundEffects,
      mergeAsr: false,
    });
    if (!targetCues.length) return null;
    return {
      platform: "youtube",
      videoKey: `yt:${videoId}:${manualTarget.track.vssId ?? manualTarget.lang ?? "target"}`,
      sourceLanguage: targetNorm,
      isAsr: false,
      hasManualTarget: true,
      cues: targetCues.map((c) => ({ ...c, translatedText: c.text })),
    };
  }

  const rawSourceCues = await loadYouTubeTrackCues(sourceTrack.track);
  const sourceCues = prepareSubtitleCues(rawSourceCues, {
    filterSoundEffects: options.filterSoundEffects,
    mergeAsr: sourceTrack.isAsr && options.mergeAsrSegments,
  });
  if (!sourceCues.length) return null;

  if (manualTarget) {
    const rawTargetCues = await loadYouTubeTrackCues(manualTarget.track);
    const targetCues = prepareSubtitleCues(rawTargetCues, {
      filterSoundEffects: options.filterSoundEffects,
      mergeAsr: false,
    });
    if (targetCues.length > 0) {
      return {
        platform: "youtube",
        videoKey: `yt:${videoId}:${sourceTrack.track.vssId ?? sourceTrack.lang ?? "src"}->manual`,
        sourceLanguage: sourceTrack.lang,
        isAsr: sourceTrack.isAsr,
        hasManualTarget: true,
        cues: alignManualTargetCues(sourceCues, targetCues),
      };
    }
  }

  return {
    platform: "youtube",
    videoKey: `yt:${videoId}:${sourceTrack.track.vssId ?? sourceTrack.lang ?? "src"}`,
    sourceLanguage: sourceTrack.lang,
    isAsr: sourceTrack.isAsr,
    hasManualTarget: false,
    cues: sourceCues,
  };
}

/* -------------------------------------------------------------------------- */
/* Bilibili Subtitle Track Discovery                                          */
/* -------------------------------------------------------------------------- */

interface BilibiliSubtitleItem {
  lan?: string;
  subtitle_url?: string;
  ai_status?: number;
}

function extractBilibiliIds(): { bvid?: string; aid?: string; cid?: string } | null {
  const bvidMatch = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
  const bvid = bvidMatch?.[1];
  for (const script of Array.from(document.scripts)) {
    const content = script.textContent ?? "";
    if (!content.includes("__INITIAL_STATE__")) continue;
    const cidMatch = content.match(/"cid"\s*:\s*(\d+)/);
    const aidMatch = content.match(/"aid"\s*:\s*(\d+)/);
    if (cidMatch?.[1]) {
      return {
        ...(bvid ? { bvid } : {}),
        ...(aidMatch?.[1] ? { aid: aidMatch[1] } : {}),
        cid: cidMatch[1],
      };
    }
  }
  return bvid ? { bvid } : null;
}

async function discoverBilibiliSubtitle(options: DiscoverTrackOptions): Promise<DiscoveredSubtitleTrack | null> {
  const ids = extractBilibiliIds();
  if (!ids?.cid || (!ids.bvid && !ids.aid)) return null;
  const query = new URLSearchParams({ cid: ids.cid });
  if (ids.bvid) query.set("bvid", ids.bvid);
  else if (ids.aid) query.set("aid", ids.aid);

  let subtitles: BilibiliSubtitleItem[] = [];
  for (const endpoint of [
    `https://api.bilibili.com/x/player/wbi/v2?${query}`,
    `https://api.bilibili.com/x/player/v2?${query}`,
  ]) {
    try {
      const raw = await fetchTrackText(endpoint);
      const parsed = JSON.parse(raw) as { data?: { subtitle?: { subtitles?: BilibiliSubtitleItem[] } } };
      const list = parsed.data?.subtitle?.subtitles;
      if (Array.isArray(list) && list.length > 0) {
        subtitles = list;
        break;
      }
    } catch {
      // Try secondary endpoint.
    }
  }
  if (!subtitles.length) return null;

  const targetNorm = normalizeDetectedLanguage(options.targetLanguage) ?? options.targetLanguage;
  const items = subtitles
    .filter((item) => typeof item.subtitle_url === "string" && item.subtitle_url.length > 0)
    .map((item) => ({
      item,
      lang: normalizeDetectedLanguage((item.lan ?? "").replace(/^ai-/, "")) ?? null,
      isAsr: (item.lan ?? "").startsWith("ai-") || item.ai_status === 2,
    }));
  if (!items.length) return null;

  const manualTarget = options.preferManualCaptions
    ? items.find((entry) => !entry.isAsr && entry.lang === targetNorm)
    : undefined;
  const sourceEntry =
    items.find((entry) => !entry.isAsr && entry.lang !== targetNorm)
    ?? items.find((entry) => entry.lang !== targetNorm)
    ?? items[0]!;

  const normalizeSubUrl = (url: string) => (url.startsWith("//") ? `https:${url}` : url);
  const rawJson = JSON.parse(await fetchTrackText(normalizeSubUrl(sourceEntry.item.subtitle_url!)));
  const sourceCues = prepareSubtitleCues(parseBilibiliSubtitleJson(rawJson), {
    filterSoundEffects: options.filterSoundEffects,
    mergeAsr: sourceEntry.isAsr && options.mergeAsrSegments,
  });
  if (!sourceCues.length) return null;

  if (manualTarget && manualTarget !== sourceEntry) {
    try {
      const targetJson = JSON.parse(await fetchTrackText(normalizeSubUrl(manualTarget.item.subtitle_url!)));
      const targetCues = prepareSubtitleCues(parseBilibiliSubtitleJson(targetJson), {
        filterSoundEffects: options.filterSoundEffects,
        mergeAsr: false,
      });
      if (targetCues.length > 0) {
        return {
          platform: "bilibili",
          videoKey: `bili:${ids.bvid ?? ids.aid}:${ids.cid}:manual`,
          sourceLanguage: sourceEntry.lang,
          isAsr: sourceEntry.isAsr,
          hasManualTarget: true,
          cues: alignManualTargetCues(sourceCues, targetCues),
        };
      }
    } catch {
      // Fall through to engine translation.
    }
  }

  return {
    platform: "bilibili",
    videoKey: `bili:${ids.bvid ?? ids.aid}:${ids.cid}:${sourceEntry.item.lan ?? "src"}`,
    sourceLanguage: sourceEntry.lang,
    isAsr: sourceEntry.isAsr,
    hasManualTarget: false,
    cues: sourceCues,
  };
}

/* -------------------------------------------------------------------------- */
/* Universal HTML5 <video><track> WebVTT Discovery                            */
/* -------------------------------------------------------------------------- */

function readInMemoryTextTrackCues(track: TextTrack): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const list = track.cues;
  if (!list) return cues;
  for (let i = 0; i < list.length; i += 1) {
    const cue = list[i] as VTTCue | undefined;
    if (!cue || typeof cue.text !== "string") continue;
    cues.push({ startTime: cue.startTime, endTime: cue.endTime, text: cue.text });
  }
  return cues;
}

async function discoverHtml5Subtitle(
  video: HTMLVideoElement,
  options: DiscoverTrackOptions,
): Promise<DiscoveredSubtitleTrack | null> {
  const targetNorm = normalizeDetectedLanguage(options.targetLanguage) ?? options.targetLanguage;
  const trackElements = Array.from(video.querySelectorAll<HTMLTrackElement>("track"))
    .filter((el) => !el.kind || el.kind === "subtitles" || el.kind === "captions");

  // 1. Prefer explicit <track src="..."> WebVTT files.
  const srcCandidates = trackElements
    .filter((el) => Boolean(el.src))
    .map((el) => ({
      el,
      lang: normalizeDetectedLanguage(el.srclang) ?? null,
    }));

  if (srcCandidates.length > 0) {
    const manualTarget = options.preferManualCaptions
      ? srcCandidates.find((c) => c.lang === targetNorm)
      : undefined;
    const chosen = srcCandidates.find((c) => c.lang !== targetNorm) ?? srcCandidates[0]!;
    const rawVtt = await fetchTrackText(chosen.el.src);
    const sourceCues = prepareSubtitleCues(parseWebVtt(rawVtt), {
      filterSoundEffects: options.filterSoundEffects,
      mergeAsr: false,
    });
    if (sourceCues.length > 0) {
      const previousModes = Array.from(video.textTracks).map((track) => ({ track, mode: track.mode }));
      for (const item of previousModes) {
        if (item.track.mode === "showing") item.track.mode = "hidden";
      }
      const restoreNativeTrack = () => {
        for (const item of previousModes) {
          try { item.track.mode = item.mode; } catch {}
        }
      };

      if (manualTarget && manualTarget !== chosen) {
        try {
          const targetVtt = await fetchTrackText(manualTarget.el.src);
          const targetCues = prepareSubtitleCues(parseWebVtt(targetVtt), {
            filterSoundEffects: options.filterSoundEffects,
            mergeAsr: false,
          });
          if (targetCues.length > 0) {
            return {
              platform: "html5",
              videoKey: `html5:${chosen.el.src}->manual`,
              sourceLanguage: chosen.lang,
              isAsr: false,
              hasManualTarget: true,
              cues: alignManualTargetCues(sourceCues, targetCues),
              restoreNativeTrack,
            };
          }
        } catch {}
      }

      return {
        platform: "html5",
        videoKey: `html5:${chosen.el.src}`,
        sourceLanguage: chosen.lang,
        isAsr: false,
        hasManualTarget: false,
        cues: sourceCues,
        restoreNativeTrack,
      };
    }
  }

  // 2. Fallback: read JS-populated TextTracks directly from video.textTracks (e.g. HLS.js/Coursera).
  const textTracks = Array.from(video.textTracks).filter(
    (t) => t.kind === "subtitles" || t.kind === "captions",
  );
  if (!textTracks.length) return null;

  const loaded = textTracks.find((t) => (t.cues?.length ?? 0) > 0) ?? textTracks[0]!;
  const previousMode = loaded.mode;
  if (loaded.mode === "disabled") loaded.mode = "hidden";
  const rawCues = readInMemoryTextTrackCues(loaded);
  const cues = prepareSubtitleCues(rawCues, {
    filterSoundEffects: options.filterSoundEffects,
    mergeAsr: false,
  });
  if (!cues.length) {
    try { loaded.mode = previousMode; } catch {}
    return null;
  }
  loaded.mode = "hidden";
  return {
    platform: "html5",
    videoKey: `html5-track:${location.href}:${loaded.language || loaded.label || "default"}`,
    sourceLanguage: normalizeDetectedLanguage(loaded.language) ?? null,
    isAsr: false,
    hasManualTarget: false,
    cues,
    restoreNativeTrack: () => {
      try { loaded.mode = previousMode; } catch {}
    },
  };
}

export async function discoverVideoSubtitles(
  video: HTMLVideoElement,
  options: DiscoverTrackOptions,
): Promise<DiscoveredSubtitleTrack | null> {
  const platform = detectVideoPlatform();
  if (platform === "youtube") {
    const yt = await discoverYouTubeSubtitle(options);
    if (yt) return yt;
  } else if (platform === "bilibili") {
    const bili = await discoverBilibiliSubtitle(options);
    if (bili) return bili;
  }
  return discoverHtml5Subtitle(video, options);
}

/** Locate the nearest player container that stays active in fullscreen mode. */
export function resolvePlayerContainer(video: HTMLVideoElement, platform: VideoPlatform): HTMLElement | null {
  if (platform === "youtube") {
    const player = video.closest<HTMLElement>("#movie_player, .html5-video-player");
    if (player) return player;
  }
  if (platform === "bilibili") {
    const player = video.closest<HTMLElement>(".bpx-player-video-area, .bilibili-player-video-wrap");
    if (player) return player;
  }
  return video.parentElement;
}
