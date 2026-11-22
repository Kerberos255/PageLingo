// Pure subtitle cue parsing, sound-effect filtering, ASR sentence merging, and fast lookup.

export interface SubtitleCue {
  startTime: number;
  endTime: number;
  text: string;
  translatedText?: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function cleanCueText(raw: string): string {
  return decodeHtmlEntities(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\u200b|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Common non-speech audio annotations in closed captions (YouTube/Netflix/WebVTT).
const SOUND_EFFECT_TOKEN_RE = /(?:\[[^\]]{1,40}\]|\((?:music|applause|laughter|laughing|cheering|sighs?|groans?|crying|sobbing|screaming|coughing|snoring|whistling|clapping|chuckles?|giggles?|silence|inaudible|crosstalk|thunder|wind|rain|door|footsteps|phone|bell|siren|beeping|gasps?|sniffs?|clears throat|background music|upbeat music|soft music|dramatic music|sound effects?|sfx)\)|（[^）]{1,18}(?:声|音乐|笑|掌声|叹气|哭|咳嗽|雷|风|雨|音乐起|背景音|静音)[^）]{0,8}）|【[^】]{1,18}(?:声|音乐|笑|掌声|音效)[^】]{0,8}】|♪[^♪\n]{0,80}♪|^[♪♫♬♩\s]+$)/giu;

export function filterSoundEffectText(raw: string): string {
  const cleaned = cleanCueText(raw);
  if (!cleaned) return "";
  const stripped = cleaned
    .replace(SOUND_EFFECT_TOKEN_RE, " ")
    .replace(/[♪♫♬♩]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Drop pure punctuation leftovers after stripping an annotation.
  if (!stripped || /^[\s.,;:!?…—–-]+$/u.test(stripped)) return "";
  return stripped;
}

function parseTimestamp(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseInt(match[3]!, 10);
  const msRaw = match[4] ?? "0";
  const ms = Number.parseInt(msRaw.padEnd(3, "0"), 10);
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

export function parseWebVtt(vttText: string): SubtitleCue[] {
  const lines = vttText.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: SubtitleCue[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line || line === "WEBVTT" || line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("REGION")) {
      if (line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("REGION")) {
        while (i < lines.length && lines[i]!.trim() !== "") i += 1;
      }
      i += 1;
      continue;
    }

    let timingLine = line;
    if (!timingLine.includes("-->") && i + 1 < lines.length && lines[i + 1]!.includes("-->")) {
      i += 1;
      timingLine = lines[i]!.trim();
    }
    if (!timingLine.includes("-->")) {
      i += 1;
      continue;
    }

    const parts = timingLine.split("-->");
    const start = parseTimestamp(parts[0] ?? "");
    const endToken = (parts[1] ?? "").trim().split(/\s+/)[0] ?? "";
    const end = parseTimestamp(endToken);
    i += 1;

    const textLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "") {
      textLines.push(lines[i]!);
      i += 1;
    }

    if (start !== null && end !== null && end > start) {
      const text = cleanCueText(textLines.join(" "));
      if (text) cues.push({ startTime: start, endTime: end, text });
    }
  }

  return normalizeCueTimeline(cues);
}

interface YouTubeJson3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

export function parseYouTubeJson3(payload: unknown): SubtitleCue[] {
  const events = (payload as { events?: YouTubeJson3Event[] } | null)?.events;
  if (!Array.isArray(events)) return [];
  const cues: SubtitleCue[] = [];
  for (const event of events) {
    if (typeof event?.tStartMs !== "number" || !Array.isArray(event.segs)) continue;
    const rawText = event.segs.map((seg) => (typeof seg?.utf8 === "string" ? seg.utf8 : "")).join("");
    const text = cleanCueText(rawText);
    if (!text) continue;
    const startTime = event.tStartMs / 1000;
    const duration = typeof event.dDurationMs === "number" && event.dDurationMs > 0 ? event.dDurationMs / 1000 : 2.5;
    cues.push({ startTime, endTime: startTime + duration, text });
  }
  return normalizeCueTimeline(cues);
}

export function parseYouTubeTimedTextXml(xmlText: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  // Format 1: <text start="1.23" dur="2.34">Hello</text>
  for (const match of xmlText.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attrs = match[1] ?? "";
    const startMatch = attrs.match(/\bstart="([^"]+)"/i);
    const durMatch = attrs.match(/\bdur="([^"]+)"/i);
    const start = startMatch ? Number.parseFloat(startMatch[1]!) : Number.NaN;
    const dur = durMatch ? Number.parseFloat(durMatch[1]!) : 2.5;
    const text = cleanCueText(match[2] ?? "");
    if (Number.isFinite(start) && text) {
      cues.push({ startTime: start, endTime: start + (Number.isFinite(dur) && dur > 0 ? dur : 2.5), text });
    }
  }
  if (cues.length > 0) return normalizeCueTimeline(cues);

  // Format 2 (srv3): <p t="1230" d="2340"><s>Hello</s></p>
  for (const match of xmlText.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const attrs = match[1] ?? "";
    const tMatch = attrs.match(/\bt="(\d+)"/i);
    const dMatch = attrs.match(/\bd="(\d+)"/i);
    const startMs = tMatch ? Number.parseInt(tMatch[1]!, 10) : Number.NaN;
    const durMs = dMatch ? Number.parseInt(dMatch[1]!, 10) : 2500;
    const text = cleanCueText(match[2] ?? "");
    if (Number.isFinite(startMs) && text) {
      cues.push({ startTime: startMs / 1000, endTime: (startMs + (durMs > 0 ? durMs : 2500)) / 1000, text });
    }
  }
  return normalizeCueTimeline(cues);
}

interface BilibiliBodyItem {
  from?: number;
  to?: number;
  content?: string;
}

export function parseBilibiliSubtitleJson(payload: unknown): SubtitleCue[] {
  const body = (payload as { body?: BilibiliBodyItem[] } | null)?.body;
  if (!Array.isArray(body)) return [];
  const cues: SubtitleCue[] = [];
  for (const item of body) {
    if (typeof item?.from !== "number" || typeof item?.to !== "number") continue;
    const text = cleanCueText(typeof item.content === "string" ? item.content : "");
    if (!text || item.to <= item.from) continue;
    cues.push({ startTime: item.from, endTime: item.to, text });
  }
  return normalizeCueTimeline(cues);
}

function normalizeCueTimeline(input: SubtitleCue[]): SubtitleCue[] {
  const sorted = input
    .filter((cue) => cue.text.length > 0 && Number.isFinite(cue.startTime) && Number.isFinite(cue.endTime) && cue.endTime > cue.startTime)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  const deduped: SubtitleCue[] = [];
  for (const cue of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.startTime - cue.startTime) < 0.05 && prev.text === cue.text) {
      prev.endTime = Math.max(prev.endTime, cue.endTime);
      continue;
    }
    // Trim overlapping tail on rolling captions so active lookup stays crisp.
    if (prev && prev.endTime > cue.startTime && cue.startTime - prev.startTime >= 0.08) {
      prev.endTime = cue.startTime;
    }
    deduped.push({ ...cue });
  }
  return deduped;
}

const SENTENCE_END_RE = /[.!?。！？…]$/u;

/**
 * Merge choppy auto-generated (ASR) caption fragments into natural sentences
 * before translation while capping duration and length for comfortable reading.
 */
export function mergeAsrCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= 1) return cues.map((cue) => ({ ...cue }));
  const merged: SubtitleCue[] = [];

  for (const cue of cues) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...cue });
      continue;
    }
    const gap = cue.startTime - prev.endTime;
    const combinedDuration = cue.endTime - prev.startTime;
    const needsSpace = !/[\p{Script=Han}\u3040-\u30ff]$/u.test(prev.text) && !/^[\p{Script=Han}\u3040-\u30ff.,!?;:]/u.test(cue.text);
    const joinedText = `${prev.text}${needsSpace ? " " : ""}${cue.text}`;

    const shouldMerge =
      gap <= 0.6
      && !SENTENCE_END_RE.test(prev.text)
      && combinedDuration <= 5.5
      && joinedText.length <= 115;

    if (shouldMerge) {
      prev.endTime = Math.max(prev.endTime, cue.endTime);
      prev.text = joinedText;
    } else {
      merged.push({ ...cue });
    }
  }
  return merged;
}

export function prepareSubtitleCues(
  rawCues: readonly SubtitleCue[],
  options: { filterSoundEffects: boolean; mergeAsr: boolean },
): SubtitleCue[] {
  let processed: SubtitleCue[] = [];
  for (const cue of rawCues) {
    const text = options.filterSoundEffects ? filterSoundEffectText(cue.text) : cleanCueText(cue.text);
    if (text) processed.push({ startTime: cue.startTime, endTime: cue.endTime, text, ...(cue.translatedText ? { translatedText: cue.translatedText } : {}) });
  }
  processed = normalizeCueTimeline(processed);
  if (options.mergeAsr) processed = mergeAsrCues(processed);
  return processed;
}

/** Pair target-language manual captions onto source cues by timestamp overlap. */
export function alignManualTargetCues(
  sourceCues: readonly SubtitleCue[],
  targetCues: readonly SubtitleCue[],
): SubtitleCue[] {
  if (sourceCues.length === 0) return targetCues.map((c) => ({ startTime: c.startTime, endTime: c.endTime, text: c.text, translatedText: c.text }));
  if (targetCues.length === 0) return sourceCues.map((c) => ({ ...c }));

  return sourceCues.map((src) => {
    const parts: string[] = [];
    for (const tgt of targetCues) {
      if (tgt.endTime <= src.startTime) continue;
      if (tgt.startTime >= src.endTime) break;
      const overlap = Math.min(src.endTime, tgt.endTime) - Math.max(src.startTime, tgt.startTime);
      const tgtDur = Math.max(0.05, tgt.endTime - tgt.startTime);
      if (overlap >= Math.min(0.2, tgtDur * 0.4)) {
        parts.push(tgt.text);
      }
    }
    return {
      ...src,
      ...(parts.length ? { translatedText: parts.join(" ") } : {}),
    };
  });
}

/** O(log n) lookup for the active subtitle cue at a given playback timestamp. */
export function findActiveCueIndex(cues: readonly SubtitleCue[], currentTime: number): number {
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (cues[mid]!.startTime <= currentTime) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate >= 0 && currentTime <= cues[candidate]!.endTime) return candidate;
  return -1;
}
