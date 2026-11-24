// Pure-TypeScript MD5 and Bilibili WBI query signing (zero external dependencies).

const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const MD5_SHIFT: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: readonly number[] = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x1_0000_0000) >>> 0,
);

function rotl32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function toHexLE(word: number): string {
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

/** Standard RFC 1321 MD5 hash returning 32 lowercase hex characters. */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x1_0000_0000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const block = new Uint32Array(16);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let j = 0; j < 16; j += 1) {
      block[j] = view.getUint32(offset + j * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }

      const nextD = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i]! + block[g]!) >>> 0;
      b = (b + rotl32(sum, MD5_SHIFT[i]!)) >>> 0;
      a = nextD;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

export function extractWbiKeyFromUrl(url: string): string {
  const slash = url.lastIndexOf("/");
  const file = slash >= 0 ? url.slice(slash + 1) : url;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

export function getBilibiliMixinKey(imgKey: string, subKey: string): string {
  const combined = `${imgKey}${subKey}`;
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    const ch = combined[MIXIN_KEY_ENC_TAB[i]!];
    if (ch) out += ch;
  }
  return out;
}

export function signBilibiliWbiParams(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  wtsSec = Math.round(Date.now() / 1000),
): string {
  const mixinKey = getBilibiliMixinKey(imgKey, subKey);
  const filtered: Record<string, string> = { wts: String(wtsSec) };
  for (const [key, rawValue] of Object.entries(params)) {
    filtered[key] = String(rawValue).replace(/[!'()*]/g, "");
  }
  const query = Object.keys(filtered)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(filtered[key]!)}`)
    .join("&");
  const wRid = md5Hex(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}

export interface BilibiliWbiKeys {
  imgKey: string;
  subKey: string;
}

const WBI_CACHE_TTL_MS = 30 * 60 * 1000;
let cachedWbiKeys: { keys: BilibiliWbiKeys; expiresAt: number } | null = null;

export function resetBilibiliWbiCacheForTests(): void {
  cachedWbiKeys = null;
}

export async function fetchBilibiliWbiKeys(
  fetchText: (url: string) => Promise<string>,
  now = Date.now(),
): Promise<BilibiliWbiKeys | null> {
  if (cachedWbiKeys && cachedWbiKeys.expiresAt > now) {
    return cachedWbiKeys.keys;
  }
  try {
    const raw = await fetchText("https://api.bilibili.com/x/web-interface/nav");
    const parsed = JSON.parse(raw) as {
      data?: { wbi_img?: { img_url?: string; sub_url?: string } };
    };
    const imgUrl = parsed.data?.wbi_img?.img_url;
    const subUrl = parsed.data?.wbi_img?.sub_url;
    if (typeof imgUrl !== "string" || typeof subUrl !== "string" || !imgUrl || !subUrl) {
      return null;
    }
    const imgKey = extractWbiKeyFromUrl(imgUrl);
    const subKey = extractWbiKeyFromUrl(subUrl);
    if (!imgKey || !subKey) return null;
    const keys = { imgKey, subKey };
    cachedWbiKeys = { keys, expiresAt: now + WBI_CACHE_TTL_MS };
    return keys;
  } catch {
    return null;
  }
}
