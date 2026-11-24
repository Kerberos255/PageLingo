// Platform-specific video subtitle discovery for YouTube, Bilibili, and standard HTML5 <video><track>.

import { normalizeDetectedLanguage } from "../shared/settings";
import { sendRuntimeMessage } from "../shared/runtime-message";
import { fetchBilibiliWbiKeys, signBilibiliWbiParams } from "./bilibili-wbi";
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
export type VideoMediaElement = HTMLVideoElement | HTMLElement;
export type SubtitleDiscoveryStatus = "ready" | "no_subtitles" | "need_login" | "need_cc" | "error";

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
  /** Backing HTML5 TextTrack for streaming/incremental HLS cue updates. */
  liveTextTrack?: TextTrack;
}

export interface SubtitleDiscoveryResult {
  track: DiscoveredSubtitleTrack | null;
  status: SubtitleDiscoveryStatus;
}

export interface DiscoverTrackOptions {
  targetLanguage: string;
  preferManualCaptions: boolean;
  filterSoundEffects: boolean;
  mergeAsrSegments: boolean;
}

export interface FetchTrackTextOptions {
  credentials?: "include" | "omit";
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

async function fetchTrackText(url: string, options: FetchTrackTextOptions = {}): Promise<string> {
  const absolute = new URL(url, location.href).href;
  const credentials = options.credentials ?? "include";

  // In Firefox content scripts, content.fetch executes with the page's exact Origin, Referer,
  // and Container Tab cookie jar — matching the player's own XHR on Bilibili and YouTube.
  const pageContent = (globalThis as { content?: { fetch?: typeof fetch } }).content;
  if (pageContent && typeof pageContent.fetch === "function") {
    try {
      const pageRes = await pageContent.fetch(absolute, { credentials });
      if (pageRes.ok) return await pageRes.text();
    } catch {
      // Fall through to extension-privileged content-script fetch.
    }
  }

  try {
    const direct = await fetch(absolute, { credentials });
    if (direct.ok) return await direct.text();
  } catch {
    // Fall back to background proxy for cross-origin CDN tracks.
  }
  const proxied = await sendRuntimeMessage<{ ok?: boolean; text?: string; error?: string }>({
    type: "fetch-subtitle-track",
    url: absolute,
    credentials,
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

export interface YouTubeDiscoverDeps {
  href?: string;
  doc?: Document;
  fetchText?: (url: string, options?: FetchTrackTextOptions) => Promise<string>;
  resourceUrls?: string[];
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
  try {
    const record = response as {
      videoDetails?: { videoId?: unknown };
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } };
    };
    const rawVideoId = record.videoDetails?.videoId;
    const videoId = typeof rawVideoId === "string" ? rawVideoId : "";
    const rawTracks = record.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!rawTracks || typeof rawTracks !== "object") return null;
    const rawLen = (rawTracks as { length?: unknown }).length;
    const len = typeof rawLen === "number" && Number.isFinite(rawLen) && rawLen > 0
      ? Math.min(Math.trunc(rawLen), 200)
      : 0;
    if (len === 0) return null;

    // Copy only primitive values via plain index access — never call page-compartment Array
    // methods (.filter/.map/.find) with content-script closures (throws Firefox Xray Permission denied).
    const tracks: YouTubeCaptionTrack[] = [];
    const list = rawTracks as Record<number, unknown>;
    for (let i = 0; i < len; i += 1) {
      const item = list[i];
      if (!item || typeof item !== "object") continue;
      const entry = item as { baseUrl?: unknown; languageCode?: unknown; kind?: unknown; vssId?: unknown };
      const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : undefined;
      if (!baseUrl) continue;
      const languageCode = typeof entry.languageCode === "string" ? entry.languageCode : undefined;
      const kind = typeof entry.kind === "string" ? entry.kind : undefined;
      const vssId = typeof entry.vssId === "string" ? entry.vssId : undefined;
      tracks.push({
        baseUrl,
        ...(languageCode ? { languageCode } : {}),
        ...(kind ? { kind } : {}),
        ...(vssId ? { vssId } : {}),
      });
    }
    return tracks.length > 0 ? { videoId, tracks } : null;
  } catch {
    return null;
  }
}

export function extractYouTubeVideoId(href = location.href): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() === "youtu.be") {
    const seg = url.pathname.replace(/^\/+/, "").split("/")[0];
    return seg || null;
  }
  const v = url.searchParams.get("v");
  if (v) return v;
  const shorts = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
  return shorts?.[1] ?? null;
}

function readLiveYouTubePlayerTracks(videoId: string, doc: Document, href: string): YouTubeCaptionTrack[] | null {
  const isShorts = (() => {
    try {
      return new URL(href).pathname.startsWith("/shorts/");
    } catch {
      return false;
    }
  })();

  const selectors = isShorts ? ["#shorts-player", "#movie_player"] : ["#movie_player", "#shorts-player"];
  for (const selector of selectors) {
    const player = doc.querySelector(selector) as
      | (HTMLElement & {
        getPlayerResponse?: () => unknown;
        wrappedJSObject?: { getPlayerResponse?: () => unknown };
      })
      | null;
    if (!player) continue;
    try {
      const target = player.wrappedJSObject ?? player;
      if (typeof target.getPlayerResponse === "function") {
        const parsed = extractYouTubeTracksFromPlayerResponse(target.getPlayerResponse());
        if (parsed && (!parsed.videoId || parsed.videoId === videoId)) {
          return parsed.tracks;
        }
      }
    } catch {
      // Fall through to next source.
    }
  }

  const view = doc.defaultView as
    | (Window & {
      ytInitialPlayerResponse?: unknown;
      wrappedJSObject?: { ytInitialPlayerResponse?: unknown };
    })
    | null;
  if (view) {
    try {
      const raw = view.wrappedJSObject?.ytInitialPlayerResponse ?? view.ytInitialPlayerResponse;
      const parsed = extractYouTubeTracksFromPlayerResponse(raw);
      if (parsed && (!parsed.videoId || parsed.videoId === videoId)) {
        return parsed.tracks;
      }
    } catch {}
  }

  return null;
}

export function findYouTubeTimedTextResourceUrls(videoId: string, doc: Document = document): string[] {
  const perf = doc.defaultView?.performance ?? globalThis.performance;
  if (!perf || typeof perf.getEntriesByType !== "function") return [];
  try {
    const entries = perf.getEntriesByType("resource");
    const matched: string[] = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = entries[i]?.name;
      if (!name || !name.includes("/api/timedtext")) continue;
      try {
        const parsed = new URL(name);
        if (parsed.searchParams.get("v") === videoId) {
          matched.push(name);
        }
      } catch {}
    }
    return matched;
  } catch {
    return [];
  }
}

async function fetchYouTubeCaptionTracks(
  videoId: string,
  href: string,
  doc: Document,
  fetchText: (url: string, options?: FetchTrackTextOptions) => Promise<string>,
): Promise<YouTubeCaptionTrack[]> {
  // 1. Live player API / window object (instant & always fresh after SPA navigation).
  const live = readLiveYouTubePlayerTracks(videoId, doc, href);
  if (live && live.length > 0) return live;

  // 2. Fast path: inspect inline scripts in the current document when videoId matches.
  for (const script of Array.from(doc.scripts)) {
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

  // 3. SPA navigation fallback: fetch the current watch page HTML with session cookies.
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl, { credentials: "include" });
  const jsonText = extractBalancedJsonObject(html, "ytInitialPlayerResponse =");
  if (!jsonText) return [];
  try {
    return extractYouTubeTracksFromPlayerResponse(JSON.parse(jsonText))?.tracks ?? [];
  } catch {
    return [];
  }
}

function buildYouTubeTimedTextCandidates(
  track: YouTubeCaptionTrack,
  resourceUrls: readonly string[],
  baseHref: string,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string) => {
    if (!rawUrl || seen.has(rawUrl)) return;
    seen.add(rawUrl);
    candidates.push(rawUrl);
  };

  const trackLang = (track.languageCode ?? "").toLowerCase();
  const trackIsAsr = track.kind === "asr";

  // 1. Prefer same-origin timedtext requests already authenticated by YouTube's own player (with pot token).
  let capturedPot: string | null = null;
  for (const resUrl of resourceUrls) {
    try {
      const parsed = new URL(resUrl);
      const pot = parsed.searchParams.get("pot");
      if (pot && !capturedPot) capturedPot = pot;
      const resLang = (parsed.searchParams.get("lang") ?? "").toLowerCase();
      const resTlang = parsed.searchParams.get("tlang");
      const resIsAsr = parsed.searchParams.get("kind") === "asr";
      if (!resTlang && (!trackLang || resLang === trackLang) && resIsAsr === trackIsAsr) {
        add(resUrl);
      }
    } catch {}
  }

  // 2. If another track on the same video already carried a player pot token, augment baseUrl with it.
  if (track.baseUrl && capturedPot) {
    try {
      const potUrl = new URL(track.baseUrl, baseHref);
      if (!potUrl.searchParams.get("pot")) {
        potUrl.searchParams.set("pot", capturedPot);
        if (!potUrl.searchParams.get("c")) potUrl.searchParams.set("c", "WEB");
      }
      add(potUrl.href);
    } catch {}
  }

  // 3. Direct baseUrl (works on videos without PO-token gating).
  if (track.baseUrl) {
    try {
      add(new URL(track.baseUrl, baseHref).href);
    } catch {
      add(track.baseUrl);
    }
  }

  return candidates;
}

async function loadYouTubeTrackCues(
  track: YouTubeCaptionTrack,
  resourceUrls: readonly string[],
  baseHref: string,
  fetchText: (url: string, options?: FetchTrackTextOptions) => Promise<string>,
): Promise<SubtitleCue[]> {
  const candidates = buildYouTubeTimedTextCandidates(track, resourceUrls, baseHref);
  for (const candidateUrl of candidates) {
    try {
      const jsonUrl = new URL(candidateUrl, baseHref);
      jsonUrl.searchParams.set("fmt", "json3");
      const raw = await fetchText(jsonUrl.href, { credentials: "include" });
      if (raw.trim().length > 0) {
        const parsed = parseYouTubeJson3(JSON.parse(raw));
        if (parsed.length > 0) return parsed;
      }
    } catch {
      // Fall back to XML timedtext format for this candidate.
    }

    try {
      const xmlRaw = await fetchText(candidateUrl, { credentials: "include" });
      if (xmlRaw.trim().length > 0) {
        const parsed = parseYouTubeTimedTextXml(xmlRaw);
        if (parsed.length > 0) return parsed;
      }
    } catch {
      // Try next candidate URL.
    }
  }
  return [];
}

export async function discoverYouTubeSubtitleDetailed(
  options: DiscoverTrackOptions,
  deps: YouTubeDiscoverDeps = {},
): Promise<SubtitleDiscoveryResult> {
  const href = deps.href ?? location.href;
  const doc = deps.doc ?? document;
  const fetchText = deps.fetchText ?? fetchTrackText;

  const videoId = extractYouTubeVideoId(href);
  if (!videoId) return { track: null, status: "no_subtitles" };

  let tracks: YouTubeCaptionTrack[];
  try {
    tracks = await fetchYouTubeCaptionTracks(videoId, href, doc, fetchText);
  } catch {
    return { track: null, status: "error" };
  }
  if (!tracks.length) return { track: null, status: "no_subtitles" };

  const targetNorm = normalizeDetectedLanguage(options.targetLanguage) ?? options.targetLanguage;
  const normalizedTracks = tracks
    .filter((t) => typeof t.baseUrl === "string" && t.baseUrl.length > 0)
    .map((track) => ({
      track,
      lang: normalizeDetectedLanguage(track.languageCode) ?? null,
      isAsr: track.kind === "asr",
    }));
  if (!normalizedTracks.length) return { track: null, status: "no_subtitles" };

  const resourceUrls = deps.resourceUrls ?? findYouTubeTimedTextResourceUrls(videoId, doc);

  const manualTarget = options.preferManualCaptions
    ? normalizedTracks.find((item) => !item.isAsr && item.lang === targetNorm)
    : undefined;
  const sourceTrack =
    normalizedTracks.find((item) => !item.isAsr && item.lang !== targetNorm)
    ?? normalizedTracks.find((item) => item.isAsr && item.lang !== targetNorm)
    ?? normalizedTracks.find((item) => !item.isAsr)
    ?? normalizedTracks[0]!;

  if (manualTarget && sourceTrack === manualTarget) {
    const rawTargetCues = await loadYouTubeTrackCues(manualTarget.track, resourceUrls, href, fetchText);
    const targetCues = prepareSubtitleCues(rawTargetCues, {
      filterSoundEffects: options.filterSoundEffects,
      mergeAsr: false,
    });
    if (!targetCues.length) return { track: null, status: "need_cc" };
    return {
      status: "ready",
      track: {
        platform: "youtube",
        videoKey: `yt:${videoId}:${manualTarget.track.vssId ?? manualTarget.lang ?? "target"}`,
        sourceLanguage: targetNorm,
        isAsr: false,
        hasManualTarget: false,
        cues: targetCues,
      },
    };
  }

  const rawSourceCues = await loadYouTubeTrackCues(sourceTrack.track, resourceUrls, href, fetchText);
  const sourceCues = prepareSubtitleCues(rawSourceCues, {
    filterSoundEffects: options.filterSoundEffects,
    mergeAsr: sourceTrack.isAsr && options.mergeAsrSegments,
  });
  if (!sourceCues.length) {
    // Caption tracks exist in playerResponse, but direct timedtext returned empty (typically PO Token exp=xpe).
    // Turning on YouTube native CC lets the player authorize timedtext or stream live captions into DOM.
    return { track: null, status: "need_cc" };
  }

  if (manualTarget) {
    const rawTargetCues = await loadYouTubeTrackCues(manualTarget.track, resourceUrls, href, fetchText);
    const targetCues = prepareSubtitleCues(rawTargetCues, {
      filterSoundEffects: options.filterSoundEffects,
      mergeAsr: false,
    });
    if (targetCues.length > 0) {
      return {
        status: "ready",
        track: {
          platform: "youtube",
          videoKey: `yt:${videoId}:${sourceTrack.track.vssId ?? sourceTrack.lang ?? "src"}->manual`,
          sourceLanguage: sourceTrack.lang,
          isAsr: sourceTrack.isAsr,
          hasManualTarget: true,
          cues: alignManualTargetCues(sourceCues, targetCues),
        },
      };
    }
  }

  return {
    status: "ready",
    track: {
      platform: "youtube",
      videoKey: `yt:${videoId}:${sourceTrack.track.vssId ?? sourceTrack.lang ?? "src"}`,
      sourceLanguage: sourceTrack.lang,
      isAsr: sourceTrack.isAsr,
      hasManualTarget: false,
      cues: sourceCues,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Bilibili Subtitle Track Discovery                                          */
/* -------------------------------------------------------------------------- */

interface BilibiliSubtitleItem {
  lan?: string;
  subtitle_url?: string;
  ai_status?: number;
  type?: number;
}

export interface BilibiliRouteIds {
  bvid?: string;
  aid?: string;
  cid?: string;
  epId?: string;
  seasonId?: string;
  page: number;
}

interface ResolvedBilibiliIds {
  bvid?: string;
  aid?: string;
  cid: string;
}

export interface BilibiliDiscoverDeps {
  href?: string;
  doc?: Document;
  fetchText?: (url: string, options?: FetchTrackTextOptions) => Promise<string>;
  resourceUrls?: string[];
}

export function extractBilibiliRouteIds(href = location.href): BilibiliRouteIds | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const pathBvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
  const queryBvidRaw = url.searchParams.get("bvid")?.trim() ?? "";
  const bvid = pathBvid || (/^BV[0-9A-Za-z]+$/i.test(queryBvidRaw) ? queryBvidRaw : undefined);

  const pathAid = url.pathname.match(/\/video\/av(\d+)/i)?.[1];
  const queryAidRaw = url.searchParams.get("aid")?.trim() ?? "";
  const aid = pathAid || (/^\d+$/.test(queryAidRaw) ? queryAidRaw : undefined);

  const queryCidRaw = url.searchParams.get("cid")?.trim() ?? "";
  const cid = /^\d+$/.test(queryCidRaw) ? queryCidRaw : undefined;

  const pathEpId = url.pathname.match(/\/bangumi\/play\/ep(\d+)/i)?.[1];
  const queryEpIdRaw = url.searchParams.get("ep_id")?.trim() ?? "";
  const epId = pathEpId || (/^\d+$/.test(queryEpIdRaw) ? queryEpIdRaw : undefined);

  const pathSeasonId = url.pathname.match(/\/bangumi\/play\/ss(\d+)/i)?.[1];
  const querySeasonIdRaw = url.searchParams.get("season_id")?.trim() ?? "";
  const seasonId = pathSeasonId || (/^\d+$/.test(querySeasonIdRaw) ? querySeasonIdRaw : undefined);

  const rawPage = Number.parseInt(url.searchParams.get("p") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  if (!bvid && !aid && !epId && !seasonId) return null;
  return {
    ...(bvid ? { bvid } : {}),
    ...(aid ? { aid } : {}),
    ...(cid ? { cid } : {}),
    ...(epId ? { epId } : {}),
    ...(seasonId ? { seasonId } : {}),
    page,
  };
}

function asPositiveIdString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return String(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim()) && Number(value.trim()) > 0) return value.trim();
  return undefined;
}

function asBvidString(value: unknown): string | undefined {
  if (typeof value === "string" && /^BV[0-9A-Za-z]+$/i.test(value.trim())) return value.trim();
  return undefined;
}

function pickPageCid(pages: unknown, page: number): string | undefined {
  if (!pages || typeof pages !== "object") return undefined;
  try {
    const rawLen = (pages as { length?: unknown }).length;
    const len = typeof rawLen === "number" && Number.isFinite(rawLen) && rawLen > 0
      ? Math.min(Math.trunc(rawLen), 5000)
      : 0;
    if (len === 0) return undefined;

    // Plain index access only: calling page-compartment Array.prototype.find with a content-script
    // closure on Firefox wrappedJSObject.__INITIAL_STATE__.videoData.pages throws Xray Permission denied.
    const list = pages as Record<number, unknown>;
    for (let i = 0; i < len; i += 1) {
      const entry = list[i];
      if (!entry || typeof entry !== "object") continue;
      if (Number((entry as { page?: unknown }).page) === page) {
        const matchedCid = asPositiveIdString((entry as { cid?: unknown }).cid);
        if (matchedCid) return matchedCid;
      }
    }
    const fallback = list[page - 1];
    if (fallback && typeof fallback === "object") {
      return asPositiveIdString((fallback as { cid?: unknown }).cid);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveIdsFromInitialState(state: unknown, route: BilibiliRouteIds): ResolvedBilibiliIds | null {
  if (!state || typeof state !== "object") return null;
  try {
    const record = state as {
      bvid?: unknown;
      aid?: unknown;
      cid?: unknown;
      videoData?: { bvid?: unknown; aid?: unknown; cid?: unknown; pages?: unknown };
      epInfo?: { id?: unknown; ep_id?: unknown; aid?: unknown; bvid?: unknown; cid?: unknown };
      mediaInfo?: { season_id?: unknown };
    };

    if (route.epId || route.seasonId) {
      const ep = record.epInfo;
      if (ep && typeof ep === "object") {
        const epMatchId = asPositiveIdString(ep.id ?? ep.ep_id);
        const seasonMatchId = asPositiveIdString(record.mediaInfo?.season_id);
        const matchesRoute =
          (route.epId && epMatchId === route.epId)
          || (!route.epId && route.seasonId && seasonMatchId === route.seasonId);
        const epCid = asPositiveIdString(ep.cid);
        const epAid = asPositiveIdString(ep.aid);
        const epBvid = asBvidString(ep.bvid);
        if (matchesRoute && epCid && (epBvid || epAid)) {
          return {
            ...(epBvid ? { bvid: epBvid } : {}),
            ...(epAid ? { aid: epAid } : {}),
            cid: epCid,
          };
        }
      }
      return null;
    }

    const videoData = record.videoData;
    const stateBvid = asBvidString(videoData?.bvid ?? record.bvid);
    const stateAid = asPositiveIdString(videoData?.aid ?? record.aid);
    const matchesRoute =
      (route.bvid && stateBvid && stateBvid.toLowerCase() === route.bvid.toLowerCase())
      || (route.aid && stateAid && stateAid === route.aid);
    if (!matchesRoute) return null;

    const pageCid = pickPageCid(videoData?.pages, route.page);
    const cid = pageCid ?? (route.page === 1 ? asPositiveIdString(videoData?.cid ?? record.cid) : undefined);
    if (!cid) return null;

    return {
      ...(stateBvid || route.bvid ? { bvid: stateBvid ?? route.bvid } : {}),
      ...(stateAid || route.aid ? { aid: stateAid ?? route.aid } : {}),
      cid,
    };
  } catch {
    return null;
  }
}

function readIdsFromWindowInitialState(doc: Document, route: BilibiliRouteIds): ResolvedBilibiliIds | null {
  const view = doc.defaultView as
    | (Window & {
      __INITIAL_STATE__?: unknown;
      wrappedJSObject?: { __INITIAL_STATE__?: unknown };
    })
    | null;
  if (!view) return null;
  try {
    const raw = view.wrappedJSObject?.__INITIAL_STATE__ ?? view.__INITIAL_STATE__ ?? null;
    return resolveIdsFromInitialState(raw, route);
  } catch {
    return null;
  }
}

function extractInitialStateFromScripts(doc: Document, route: BilibiliRouteIds): ResolvedBilibiliIds | null {
  for (const script of Array.from(doc.scripts)) {
    const content = script.textContent ?? "";
    if (!content.includes("__INITIAL_STATE__")) continue;
    const jsonText =
      extractBalancedJsonObject(content, "__INITIAL_STATE__=")
      ?? extractBalancedJsonObject(content, "__INITIAL_STATE__ =");
    if (jsonText) {
      try {
        const resolved = resolveIdsFromInitialState(JSON.parse(jsonText), route);
        if (resolved) return resolved;
      } catch {
        // Fall through to guarded regex fallback for page 1.
      }
    }
    if (route.page === 1 && (route.bvid || route.aid)) {
      const matchesScript =
        (route.bvid && content.toLowerCase().includes(route.bvid.toLowerCase()))
        || (route.aid && new RegExp(`"aid"\\s*:\\s*${route.aid}\\b`).test(content));
      if (!matchesScript) continue;
      const cidMatch = content.match(/"cid"\s*:\s*(\d+)/);
      const aidMatch = content.match(/"aid"\s*:\s*(\d+)/);
      const resolvedAid = route.aid ?? aidMatch?.[1];
      if (cidMatch?.[1]) {
        return {
          ...(route.bvid ? { bvid: route.bvid } : {}),
          ...(resolvedAid ? { aid: resolvedAid } : {}),
          cid: cidMatch[1],
        };
      }
    }
  }
  return null;
}

async function resolveBilibiliVideoIds(
  route: BilibiliRouteIds,
  doc: Document,
  fetchText: (url: string, options?: FetchTrackTextOptions) => Promise<string>,
): Promise<ResolvedBilibiliIds | null> {
  if (route.cid && (route.bvid || route.aid)) {
    return {
      ...(route.bvid ? { bvid: route.bvid } : {}),
      ...(route.aid ? { aid: route.aid } : {}),
      cid: route.cid,
    };
  }

  // 1. Live window.__INITIAL_STATE__ (only trusted when it matches current URL route).
  const fromWindow = readIdsFromWindowInitialState(doc, route);
  if (fromWindow) return fromWindow;

  // 2. Authoritative Bilibili metadata API (never stale across SPA navigation or ?p=N).
  if (route.bvid || route.aid) {
    try {
      const viewQuery = route.bvid
        ? `bvid=${encodeURIComponent(route.bvid)}`
        : `aid=${encodeURIComponent(route.aid!)}`;
      const raw = await fetchText(`https://api.bilibili.com/x/web-interface/view?${viewQuery}`, { credentials: "include" });
      const parsed = JSON.parse(raw) as {
        code?: number;
        data?: { bvid?: unknown; aid?: unknown; cid?: unknown; pages?: unknown };
      };
      if (parsed.code === 0 && parsed.data) {
        const bvid = asBvidString(parsed.data.bvid) ?? route.bvid;
        const aid = asPositiveIdString(parsed.data.aid) ?? route.aid;
        const cid = pickPageCid(parsed.data.pages, route.page) ?? asPositiveIdString(parsed.data.cid);
        if (cid && (bvid || aid)) {
          return { ...(bvid ? { bvid } : {}), ...(aid ? { aid } : {}), cid };
        }
      }
    } catch {
      // Fall back to inline script extraction below.
    }
  } else if (route.epId || route.seasonId) {
    try {
      const seasonQuery = route.epId
        ? `ep_id=${encodeURIComponent(route.epId)}`
        : `season_id=${encodeURIComponent(route.seasonId!)}`;
      const raw = await fetchText(`https://api.bilibili.com/pgc/view/web/season?${seasonQuery}`, { credentials: "include" });
      const parsed = JSON.parse(raw) as {
        code?: number;
        result?: {
          episodes?: Array<{ id?: unknown; ep_id?: unknown; aid?: unknown; bvid?: unknown; cid?: unknown }>;
          section?: Array<{ episodes?: Array<{ id?: unknown; ep_id?: unknown; aid?: unknown; bvid?: unknown; cid?: unknown }> }>;
          sections?: Array<{ episodes?: Array<{ id?: unknown; ep_id?: unknown; aid?: unknown; bvid?: unknown; cid?: unknown }> }>;
        };
      };
      if (parsed.code === 0 && parsed.result) {
        const allEpisodes = [
          ...(Array.isArray(parsed.result.episodes) ? parsed.result.episodes : []),
          ...(Array.isArray(parsed.result.section) ? parsed.result.section.flatMap((s) => s.episodes ?? []) : []),
          ...(Array.isArray(parsed.result.sections) ? parsed.result.sections.flatMap((s) => s.episodes ?? []) : []),
        ];
        const chosen = route.epId
          ? allEpisodes.find((ep) => asPositiveIdString(ep.id ?? ep.ep_id) === route.epId)
          : allEpisodes.find((ep) => Boolean(asPositiveIdString(ep.cid)));
        if (chosen) {
          const cid = asPositiveIdString(chosen.cid);
          const aid = asPositiveIdString(chosen.aid);
          const bvid = asBvidString(chosen.bvid);
          if (cid && (bvid || aid)) {
            return { ...(bvid ? { bvid } : {}), ...(aid ? { aid } : {}), cid };
          }
        }
      }
    } catch {
      // Fall back to inline script extraction below.
    }
  }

  // 3. Inline SSR <script> fallback (guarded to match current route IDs).
  return extractInitialStateFromScripts(doc, route);
}

function normalizeBilibiliSubtitleUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("http://")) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname.endsWith(".hdslb.com") || parsed.hostname.endsWith(".bilibili.com")) {
        parsed.protocol = "https:";
        return parsed.href;
      }
    } catch {}
  }
  return trimmed;
}

export function findBilibiliSubtitleResourceUrls(cid: string, doc: Document = document): string[] {
  const perf = doc.defaultView?.performance ?? globalThis.performance;
  if (!perf || typeof perf.getEntriesByType !== "function") return [];
  try {
    const entries = perf.getEntriesByType("resource");
    const matched: string[] = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = entries[i]?.name;
      if (!name || !name.includes(cid)) continue;
      try {
        const parsed = new URL(name);
        if (
          parsed.hostname.endsWith(".hdslb.com")
          && (parsed.pathname.includes("/bfs/ai_subtitle/") || parsed.pathname.includes("/bfs/subtitle/"))
        ) {
          matched.push(name);
        }
      } catch {}
    }
    return matched;
  } catch {
    return [];
  }
}

export async function discoverBilibiliSubtitleDetailed(
  options: DiscoverTrackOptions,
  deps: BilibiliDiscoverDeps = {},
): Promise<SubtitleDiscoveryResult> {
  const href = deps.href ?? location.href;
  const doc = deps.doc ?? document;
  const fetchText = deps.fetchText ?? fetchTrackText;

  const route = extractBilibiliRouteIds(href);
  if (!route) return { track: null, status: "no_subtitles" };

  const ids = await resolveBilibiliVideoIds(route, doc, fetchText);
  if (!ids?.cid || (!ids.bvid && !ids.aid)) {
    return { track: null, status: "no_subtitles" };
  }

  const baseParams: Record<string, string> = { cid: ids.cid };
  if (ids.bvid) baseParams.bvid = ids.bvid;
  if (ids.aid) baseParams.aid = ids.aid;

  const endpoints: string[] = [];
  const wbiKeys = await fetchBilibiliWbiKeys((url) => fetchText(url, { credentials: "include" }));
  if (wbiKeys) {
    const signed = signBilibiliWbiParams(baseParams, wbiKeys.imgKey, wbiKeys.subKey);
    endpoints.push(`https://api.bilibili.com/x/player/wbi/v2?${signed}`);
  }
  endpoints.push(`https://api.bilibili.com/x/player/wbi/v2?${new URLSearchParams(baseParams)}`);

  let subtitles: BilibiliSubtitleItem[] = [];
  let apiSucceeded = false;
  let needLogin = false;

  for (const endpoint of endpoints) {
    try {
      const raw = await fetchText(endpoint, { credentials: "include" });
      const parsed = JSON.parse(raw) as {
        code?: number;
        data?: {
          login_mid?: number;
          need_login_subtitle?: boolean;
          subtitle?: { subtitles?: BilibiliSubtitleItem[] };
        };
      };
      if (parsed.code === -101) {
        needLogin = true;
        continue;
      }
      if (parsed.code !== undefined && parsed.code !== 0) {
        continue;
      }
      apiSucceeded = true;
      if (parsed.data?.need_login_subtitle === true || parsed.data?.login_mid === 0) {
        needLogin = true;
      }
      const list = parsed.data?.subtitle?.subtitles;
      const usable = Array.isArray(list)
        ? list.filter((item) => typeof item?.subtitle_url === "string" && item.subtitle_url.trim().length > 0)
        : [];
      if (usable.length > 0) {
        subtitles = usable;
        break;
      }
      // Endpoint succeeded cleanly with no usable subtitle URLs; no need to retry unsigned.
      break;
    } catch {
      // Try next endpoint variant.
    }
  }

  if (!subtitles.length) {
    // Fallback: if Bilibili's own player already loaded a subtitle JSON for this cid, reuse it directly.
    const resourceUrls = deps.resourceUrls ?? findBilibiliSubtitleResourceUrls(ids.cid, doc);
    for (const resourceUrl of resourceUrls) {
      try {
        const rawJson = JSON.parse(await fetchText(normalizeBilibiliSubtitleUrl(resourceUrl), { credentials: "omit" }));
        const cues = prepareSubtitleCues(parseBilibiliSubtitleJson(rawJson), {
          filterSoundEffects: options.filterSoundEffects,
          mergeAsr: resourceUrl.includes("/ai_subtitle/") && options.mergeAsrSegments,
        });
        if (cues.length > 0) {
          return {
            status: "ready",
            track: {
              platform: "bilibili",
              videoKey: `bili:${ids.bvid ?? ids.aid}:${ids.cid}:resource`,
              sourceLanguage: null,
              isAsr: resourceUrl.includes("/ai_subtitle/"),
              hasManualTarget: false,
              cues,
            },
          };
        }
      } catch {
        // Try next captured subtitle resource URL.
      }
    }

    return {
      track: null,
      status: needLogin ? "need_login" : apiSucceeded ? "no_subtitles" : "error",
    };
  }

  const targetNorm = normalizeDetectedLanguage(options.targetLanguage) ?? options.targetLanguage;
  const items = subtitles
    .filter((item) => typeof item.subtitle_url === "string" && item.subtitle_url.trim().length > 0)
    .map((item) => {
      const rawLan = (item.lan ?? "").trim();
      const cleanedLan = rawLan.replace(/(?:^ai-|-ai$)/i, "");
      const isAsr = /^(?:ai-)|(?:-ai)$/i.test(rawLan) || item.ai_status === 2 || item.type === 1;
      return {
        item,
        lang: normalizeDetectedLanguage(cleanedLan) ?? null,
        isAsr,
      };
    });
  if (!items.length) return { track: null, status: needLogin ? "need_login" : "no_subtitles" };

  const manualTarget = options.preferManualCaptions
    ? items.find((entry) => !entry.isAsr && entry.lang === targetNorm)
    : undefined;
  const sourceEntry =
    items.find((entry) => !entry.isAsr && entry.lang !== targetNorm)
    ?? items.find((entry) => entry.lang !== targetNorm)
    ?? items[0]!;

  try {
    const rawJson = JSON.parse(
      await fetchText(normalizeBilibiliSubtitleUrl(sourceEntry.item.subtitle_url!), { credentials: "omit" }),
    );
    const sourceCues = prepareSubtitleCues(parseBilibiliSubtitleJson(rawJson), {
      filterSoundEffects: options.filterSoundEffects,
      mergeAsr: sourceEntry.isAsr && options.mergeAsrSegments,
    });
    if (!sourceCues.length) return { track: null, status: "no_subtitles" };

    if (manualTarget && manualTarget === sourceEntry) {
      return {
        status: "ready",
        track: {
          platform: "bilibili",
          videoKey: `bili:${ids.bvid ?? ids.aid}:${ids.cid}:${manualTarget.item.lan ?? "target"}`,
          sourceLanguage: targetNorm,
          isAsr: false,
          hasManualTarget: false,
          cues: sourceCues,
        },
      };
    }

    if (manualTarget && manualTarget !== sourceEntry) {
      try {
        const targetJson = JSON.parse(
          await fetchText(normalizeBilibiliSubtitleUrl(manualTarget.item.subtitle_url!), { credentials: "omit" }),
        );
        const targetCues = prepareSubtitleCues(parseBilibiliSubtitleJson(targetJson), {
          filterSoundEffects: options.filterSoundEffects,
          mergeAsr: false,
        });
        if (targetCues.length > 0) {
          return {
            status: "ready",
            track: {
              platform: "bilibili",
              videoKey: `bili:${ids.bvid ?? ids.aid}:${ids.cid}:manual`,
              sourceLanguage: sourceEntry.lang,
              isAsr: sourceEntry.isAsr,
              hasManualTarget: true,
              cues: alignManualTargetCues(sourceCues, targetCues),
            },
          };
        }
      } catch {
        // Fall through to engine translation.
      }
    }

    return {
      status: "ready",
      track: {
        platform: "bilibili",
        videoKey: `bili:${ids.bvid ?? ids.aid}:${ids.cid}:${sourceEntry.item.lan ?? "src"}`,
        sourceLanguage: sourceEntry.lang,
        isAsr: sourceEntry.isAsr,
        hasManualTarget: false,
        cues: sourceCues,
      },
    };
  } catch {
    return { track: null, status: "error" };
  }
}

/* -------------------------------------------------------------------------- */
/* Universal HTML5 <video><track> WebVTT Discovery                            */
/* -------------------------------------------------------------------------- */

export function readTextTrackCues(track: TextTrack): SubtitleCue[] {
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

async function waitForTextTrackCues(
  video: VideoMediaElement,
  track: TextTrack,
  timeoutMs = 1200,
): Promise<SubtitleCue[]> {
  const immediate = readTextTrackCues(track);
  if (immediate.length > 0 || timeoutMs <= 0) return immediate;

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const trackEl = Array.from(video.querySelectorAll<HTMLTrackElement>("track"))
      .find((el) => el.track === track) ?? null;

    const finish = (cues: SubtitleCue[]) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try { track.removeEventListener("cuechange", check); } catch {}
      if (trackEl) trackEl.removeEventListener("load", check);
      resolve(cues);
    };

    const check = () => {
      const cues = readTextTrackCues(track);
      if (cues.length > 0) finish(cues);
    };

    try { track.addEventListener("cuechange", check); } catch {}
    if (trackEl) trackEl.addEventListener("load", check);
    pollTimer = setInterval(check, 120);
    timeoutTimer = setTimeout(() => finish(readTextTrackCues(track)), timeoutMs);
  });
}

export interface Html5DiscoverDeps {
  fetchText?: (url: string, options?: FetchTrackTextOptions) => Promise<string>;
  waitTimeoutMs?: number;
}

export async function discoverHtml5Subtitle(
  video: VideoMediaElement,
  options: DiscoverTrackOptions,
  deps: Html5DiscoverDeps = {},
): Promise<DiscoveredSubtitleTrack | null> {
  const fetchText = deps.fetchText ?? fetchTrackText;
  const waitTimeoutMs = deps.waitTimeoutMs ?? 1200;
  const targetNorm = normalizeDetectedLanguage(options.targetLanguage) ?? options.targetLanguage;
  const trackElements = Array.from(video.querySelectorAll<HTMLTrackElement>("track"))
    .filter((el) => !el.kind || el.kind === "subtitles" || el.kind === "captions");
  const nativeTextTracks = "textTracks" in video && video.textTracks ? Array.from(video.textTracks) : [];

  const pageLang = normalizeDetectedLanguage(video.ownerDocument?.documentElement?.lang) ?? null;
  const rankSourceTrack = (item: {
    lang: string | null;
    isShowing: boolean;
    isDefault: boolean;
    hasCues?: boolean;
  }): number => {
    let score = 0;
    if (item.hasCues) score += 100;
    const isTarget = item.lang !== null && item.lang === targetNorm;
    if (!isTarget) score += 40;
    if (item.isShowing && !isTarget) score += 30;
    if (item.isDefault && !isTarget) score += 20;
    if (pageLang && pageLang !== targetNorm && item.lang === pageLang) score += 12;
    if (targetNorm !== "en" && item.lang === "en") score += 8;
    return score;
  };

  // 1. Prefer explicit <track src="..."> WebVTT files.
  const srcCandidates = trackElements
    .filter((el) => Boolean(el.src))
    .map((el) => ({
      el,
      lang: normalizeDetectedLanguage(el.srclang) ?? null,
      isShowing: el.track?.mode === "showing",
      isDefault: Boolean(el.default),
    }));

  if (srcCandidates.length > 0) {
    const manualTarget = options.preferManualCaptions
      ? srcCandidates.find((c) => c.lang === targetNorm)
      : undefined;
    const chosen = [...srcCandidates].sort((a, b) => rankSourceTrack(b) - rankSourceTrack(a))[0]!;
    try {
      const rawVtt = await fetchText(chosen.el.src);
      const sourceCues = prepareSubtitleCues(parseWebVtt(rawVtt), {
        filterSoundEffects: options.filterSoundEffects,
        mergeAsr: false,
      });
      if (sourceCues.length > 0) {
        const previousModes = nativeTextTracks.map((track) => ({ track, mode: track.mode }));
        for (const item of previousModes) {
          if (item.track.mode === "showing") item.track.mode = "hidden";
        }
        const restoreNativeTrack = () => {
          for (const item of previousModes) {
            try { item.track.mode = item.mode; } catch {}
          }
        };

        if (manualTarget && manualTarget === chosen) {
          return {
            platform: "html5",
            videoKey: `html5:${chosen.el.src}:target`,
            sourceLanguage: targetNorm,
            isAsr: false,
            hasManualTarget: false,
            cues: sourceCues,
            restoreNativeTrack,
          };
        }

        if (manualTarget && manualTarget !== chosen) {
          try {
            const targetVtt = await fetchText(manualTarget.el.src);
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
    } catch {
      // Fall through to in-memory video.textTracks discovery.
    }
  }

  // 2. Fallback: read JS-populated TextTracks from video.textTracks (e.g. HLS.js / Shaka / Coursera / Udemy / Vimeo).
  const textTracks = nativeTextTracks.filter(
    (t) => !t.kind || t.kind === "subtitles" || t.kind === "captions",
  );
  if (!textTracks.length) return null;

  const normalized = textTracks.map((track) => {
    const matchingEl = trackElements.find((el) => el.track === track);
    return {
      track,
      lang: normalizeDetectedLanguage(track.language) ?? null,
      hasCues: (track.cues?.length ?? 0) > 0,
      isShowing: track.mode === "showing",
      isDefault: Boolean(matchingEl?.default),
    };
  });
  const ordered = [...normalized].sort((a, b) => rankSourceTrack(b) - rankSourceTrack(a));

  for (const candidate of ordered) {
    const track = candidate.track;
    const previousMode = track.mode;
    if (track.mode === "disabled") {
      try { track.mode = "hidden"; } catch {}
    }
    const rawCues = await waitForTextTrackCues(video, track, waitTimeoutMs);
    const cues = prepareSubtitleCues(rawCues, {
      filterSoundEffects: options.filterSoundEffects,
      mergeAsr: false,
    });
    if (!cues.length) {
      try { track.mode = previousMode; } catch {}
      continue;
    }

    const previousModes = nativeTextTracks.map((t) => ({ track: t, mode: t === track ? previousMode : t.mode }));
    for (const item of previousModes) {
      if (item.track === track || item.track.mode === "showing") {
        try { item.track.mode = "hidden"; } catch {}
      }
    }

    return {
      platform: "html5",
      videoKey: `html5-track:${location.href}:${track.language || track.label || "default"}`,
      sourceLanguage: candidate.lang,
      isAsr: false,
      hasManualTarget: false,
      cues,
      liveTextTrack: track,
      restoreNativeTrack: () => {
        for (const item of previousModes) {
          try { item.track.mode = item.mode; } catch {}
        }
      },
    };
  }

  return null;
}

export async function discoverVideoSubtitlesDetailed(
  video: VideoMediaElement,
  options: DiscoverTrackOptions,
): Promise<SubtitleDiscoveryResult> {
  const platform = detectVideoPlatform();
  if (platform === "youtube") {
    const yt = await discoverYouTubeSubtitleDetailed(options);
    if (yt.track) return yt;
    const html5 = await discoverHtml5Subtitle(video, options);
    if (html5) return { track: html5, status: "ready" };
    return yt;
  } else if (platform === "bilibili") {
    const bili = await discoverBilibiliSubtitleDetailed(options);
    if (bili.track) return bili;
    const html5 = await discoverHtml5Subtitle(video, options);
    if (html5) return { track: html5, status: "ready" };
    return bili;
  }
  const html5 = await discoverHtml5Subtitle(video, options);
  return html5 ? { track: html5, status: "ready" } : { track: null, status: "no_subtitles" };
}

export async function discoverVideoSubtitles(
  video: VideoMediaElement,
  options: DiscoverTrackOptions,
): Promise<DiscoveredSubtitleTrack | null> {
  const result = await discoverVideoSubtitlesDetailed(video, options);
  return result.track;
}

const BILIBILI_PLAYER_CONTAINER_SELECTOR =
  ".bpx-player-video-area, .bilibili-player-area, .bilibili-player-video-wrap, .bpx-player-primary-area, .bpx-player-container";
const BILIBILI_CONTROLS_SELECTOR =
  ".bpx-player-control-bottom-right, .bilibili-player-video-control-bottom-right, .squirtle-controller-wrap-right";
const YOUTUBE_PLAYER_CONTAINER_SELECTOR = "#movie_player, #shorts-player, .html5-video-player";
const HTML5_PLAYER_CONTAINER_SELECTOR = [
  ".video-js",
  ".plyr",
  "media-controller",
  "media-container",
  ".vp-player",
  ".player[data-player-id]",
  ".vp-video-wrapper",
  '[data-purpose="video-player"]',
  ".shaka-video-container",
  ".jwplayer",
  ".dplayer",
  ".art-video-player",
  ".xgplayer",
  '[data-testid="video-player"]',
].join(", ");

export interface PlatformControlsTarget {
  element: HTMLElement;
  mountKind: "youtube" | "bilibili" | "html5-inline";
  placement: "prepend" | "append" | "before-fullscreen";
  fullscreenSelector?: string;
}

const HTML5_CONTROLS_SPECS: ReadonlyArray<{
  selector: string;
  placement: "prepend" | "append" | "before-fullscreen";
  fullscreenSelector?: string;
}> = [
  { selector: ".vjs-control-bar", placement: "before-fullscreen", fullscreenSelector: ".vjs-fullscreen-control" },
  { selector: ".plyr__controls", placement: "before-fullscreen", fullscreenSelector: '[data-plyr="fullscreen"]' },
  { selector: ".shaka-controls-button-panel", placement: "before-fullscreen", fullscreenSelector: ".shaka-fullscreen-button" },
  { selector: ".jw-button-container", placement: "before-fullscreen", fullscreenSelector: ".jw-icon-fullscreen" },
  { selector: ".dplayer-icons-right", placement: "prepend" },
  { selector: ".art-controls-right", placement: "prepend" },
  { selector: ".vp-controls .vp-controls-wrapper, .vp-controls", placement: "append" },
  { selector: '[data-purpose="video-controls"]', placement: "append" },
  { selector: ".xgplayer-controls", placement: "append" },
];

/** Locate the nearest player container that stays active in fullscreen mode. */
export function resolvePlayerContainer(video: VideoMediaElement, platform: VideoPlatform): HTMLElement | null {
  if (platform === "youtube") {
    const player = video.closest<HTMLElement>(YOUTUBE_PLAYER_CONTAINER_SELECTOR);
    if (player) return player;
  }
  if (platform === "bilibili") {
    const player = video.closest<HTMLElement>(BILIBILI_PLAYER_CONTAINER_SELECTOR);
    if (player) return player;
  }
  if (platform === "html5") {
    const player = video.closest<HTMLElement>(HTML5_PLAYER_CONTAINER_SELECTOR);
    if (player) return player;
  }
  return video.parentElement;
}

/** True when container is a recognized main video player (not a hover preview thumbnail or decorative video). */
export function isKnownPlatformPlayerContainer(container: HTMLElement, platform: VideoPlatform): boolean {
  if (platform === "youtube") {
    return container.matches(YOUTUBE_PLAYER_CONTAINER_SELECTOR)
      && !container.closest("#inline-preview-player, ytd-video-preview");
  }
  if (platform === "bilibili") {
    return container.matches(BILIBILI_PLAYER_CONTAINER_SELECTOR);
  }
  return container.matches(HTML5_PLAYER_CONTAINER_SELECTOR);
}

/** Locate the platform's control bar and insertion strategy for mounting the quick toggle button inline. */
export function resolvePlatformControlsTarget(
  container: HTMLElement,
  platform: VideoPlatform,
): PlatformControlsTarget | null {
  if (platform === "youtube") {
    // Shorts player does not show the classic .ytp-right-controls bar; let it use floating pill cleanly.
    if (container.id === "shorts-player") return null;
    const yt = container.querySelector<HTMLElement>(".ytp-right-controls");
    return yt ? { element: yt, mountKind: "youtube", placement: "prepend" } : null;
  }
  if (platform === "bilibili") {
    const direct = container.querySelector<HTMLElement>(BILIBILI_CONTROLS_SELECTOR);
    const outer = direct
      ? null
      : container.closest<HTMLElement>(".bpx-player-container, .bpx-player-primary-area, .bilibili-player-area")
        ?.querySelector<HTMLElement>(BILIBILI_CONTROLS_SELECTOR) ?? null;
    const bili = direct ?? outer;
    return bili ? { element: bili, mountKind: "bilibili", placement: "prepend" } : null;
  }
  for (const spec of HTML5_CONTROLS_SPECS) {
    const found = container.querySelector<HTMLElement>(spec.selector);
    if (found) {
      return {
        element: found,
        mountKind: "html5-inline",
        placement: spec.placement,
        ...(spec.fullscreenSelector ? { fullscreenSelector: spec.fullscreenSelector } : {}),
      };
    }
  }
  return null;
}

/** Backwards-compatible wrapper returning only the matched control bar element. */
export function resolvePlatformControlsContainer(
  container: HTMLElement,
  platform: VideoPlatform,
): HTMLElement | null {
  return resolvePlatformControlsTarget(container, platform)?.element ?? null;
}
