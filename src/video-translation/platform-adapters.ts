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
export type SubtitleDiscoveryStatus = "ready" | "no_subtitles" | "need_login" | "error";

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
  if (!Array.isArray(pages) || pages.length === 0) return undefined;
  const byNumber = pages.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return Number((entry as { page?: unknown }).page) === page;
  }) as { cid?: unknown } | undefined;
  const fallback = pages[page - 1] as { cid?: unknown } | undefined;
  return asPositiveIdString(byNumber?.cid ?? fallback?.cid);
}

function resolveIdsFromInitialState(state: unknown, route: BilibiliRouteIds): ResolvedBilibiliIds | null {
  if (!state || typeof state !== "object") return null;
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
}

function readWindowInitialState(doc: Document): unknown {
  const view = doc.defaultView as
    | (Window & {
      __INITIAL_STATE__?: unknown;
      wrappedJSObject?: { __INITIAL_STATE__?: unknown };
    })
    | null;
  if (!view) return null;
  try {
    return view.wrappedJSObject?.__INITIAL_STATE__ ?? view.__INITIAL_STATE__ ?? null;
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
  const fromWindow = resolveIdsFromInitialState(readWindowInitialState(doc), route);
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
      const list = parsed.data?.subtitle?.subtitles;
      if (Array.isArray(list) && list.length > 0) {
        subtitles = list;
        break;
      }
      if (parsed.data?.need_login_subtitle === true || parsed.data?.login_mid === 0) {
        needLogin = true;
      }
      // Endpoint succeeded cleanly with an empty subtitle list; no need to retry unsigned.
      break;
    } catch {
      // Try next endpoint variant.
    }
  }

  if (!subtitles.length) {
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
  if (!items.length) return { track: null, status: "no_subtitles" };

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
          hasManualTarget: true,
          cues: sourceCues.map((c) => ({ ...c, translatedText: c.text })),
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
  video: VideoMediaElement,
  options: DiscoverTrackOptions,
): Promise<DiscoveredSubtitleTrack | null> {
  const targetNorm = normalizeDetectedLanguage(options.targetLanguage) ?? options.targetLanguage;
  const trackElements = Array.from(video.querySelectorAll<HTMLTrackElement>("track"))
    .filter((el) => !el.kind || el.kind === "subtitles" || el.kind === "captions");
  const nativeTextTracks = "textTracks" in video && video.textTracks ? Array.from(video.textTracks) : [];

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
      const previousModes = nativeTextTracks.map((track) => ({ track, mode: track.mode }));
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
  const textTracks = nativeTextTracks.filter(
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

export async function discoverVideoSubtitlesDetailed(
  video: VideoMediaElement,
  options: DiscoverTrackOptions,
): Promise<SubtitleDiscoveryResult> {
  const platform = detectVideoPlatform();
  if (platform === "youtube") {
    try {
      const yt = await discoverYouTubeSubtitle(options);
      if (yt) return { track: yt, status: "ready" };
    } catch {
      const html5 = await discoverHtml5Subtitle(video, options);
      return html5 ? { track: html5, status: "ready" } : { track: null, status: "error" };
    }
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
const YOUTUBE_PLAYER_CONTAINER_SELECTOR = "#movie_player, .html5-video-player";

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
  return video.parentElement;
}

/** True when container is a recognized main video player (not a hover preview thumbnail). */
export function isKnownPlatformPlayerContainer(container: HTMLElement, platform: VideoPlatform): boolean {
  if (platform === "youtube") {
    return container.matches(YOUTUBE_PLAYER_CONTAINER_SELECTOR)
      && !container.closest("#inline-preview-player, ytd-video-preview");
  }
  if (platform === "bilibili") {
    return container.matches(BILIBILI_PLAYER_CONTAINER_SELECTOR);
  }
  return false;
}

/** Locate the platform's bottom-right control bar for mounting the quick toggle button inline. */
export function resolvePlatformControlsContainer(
  container: HTMLElement,
  platform: VideoPlatform,
): HTMLElement | null {
  if (platform === "youtube") {
    return container.querySelector<HTMLElement>(".ytp-right-controls");
  }
  if (platform === "bilibili") {
    const direct = container.querySelector<HTMLElement>(BILIBILI_CONTROLS_SELECTOR);
    if (direct) return direct;
    const outer = container.closest<HTMLElement>(".bpx-player-container, .bpx-player-primary-area, .bilibili-player-area");
    return outer?.querySelector<HTMLElement>(BILIBILI_CONTROLS_SELECTOR) ?? null;
  }
  return null;
}
