// Extension point for future AI subtitle generation (local ASR / cloud transcription)
// when a video does not provide soft CC/AI subtitle tracks.

import type { DiscoveredSubtitleTrack, VideoMediaElement, VideoPlatform } from "./platform-adapters";

export interface AiSubtitleRequest {
  video: VideoMediaElement;
  platform: VideoPlatform;
  url: string;
  targetLanguage: string;
  signal: AbortSignal;
}

export interface AiSubtitleProvider {
  readonly id: string;
  readonly label: string;
  isAvailable(): boolean | Promise<boolean>;
  generateTrack(request: AiSubtitleRequest): Promise<DiscoveredSubtitleTrack | null>;
}

let activeAiSubtitleProvider: AiSubtitleProvider | null = null;

/** Register (or clear with null) the active AI subtitle provider used when no soft subtitles exist. */
export function registerAiSubtitleProvider(provider: AiSubtitleProvider | null): void {
  activeAiSubtitleProvider = provider;
}

/** Return the currently registered AI subtitle provider, if any. */
export function getAiSubtitleProvider(): AiSubtitleProvider | null {
  return activeAiSubtitleProvider;
}
