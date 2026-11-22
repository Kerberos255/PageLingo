/**
 * Minimal zero-dependency ZIP archive reader built on Web Streams DecompressionStream("deflate-raw").
 * Used locally in Firefox to unpack EPUB and DOCX archives without external zip libraries.
 */

export interface ZipEntryMeta {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("当前浏览器环境不支持 DecompressionStream，无法解压文档");
  }
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(compressed.byteLength);
  payload.set(compressed);
  const writePromise = writer.write(payload).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    await writePromise;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class ZipArchive {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly entries = new Map<string, ZipEntryMeta>();

  private constructor(bytes: Uint8Array, list: ZipEntryMeta[]) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const entry of list) {
      this.entries.set(entry.name, entry);
    }
  }

  static open(buffer: ArrayBuffer | Uint8Array): ZipArchive {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength < 22) throw new Error("压缩文档损坏或格式无效");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const minOffset = Math.max(0, bytes.byteLength - 65557);
    let eocdOffset = -1;
    for (let pos = bytes.byteLength - 22; pos >= minOffset; pos -= 1) {
      if (view.getUint32(pos, true) === EOCD_SIGNATURE) {
        eocdOffset = pos;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("未找到有效的 ZIP 目录结构");

    const entryCount = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const decoder = new TextDecoder("utf-8");
    const list: ZipEntryMeta[] = [];

    let offset = cdOffset;
    for (let i = 0; i < entryCount && offset + 46 <= bytes.byteLength; i += 1) {
      if (view.getUint32(offset, true) !== CD_SIGNATURE) break;
      const compressionMethod = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
      list.push({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      offset += 46 + nameLen + extraLen + commentLen;
    }

    return new ZipArchive(bytes, list);
  }

  listNames(): string[] {
    return Array.from(this.entries.keys());
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async readBytes(name: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const pos = entry.localHeaderOffset;
    if (pos + 30 > this.bytes.byteLength || this.view.getUint32(pos, true) !== LFH_SIGNATURE) {
      throw new Error(`无法读取文档条目：${name}`);
    }
    const nameLen = this.view.getUint16(pos + 26, true);
    const extraLen = this.view.getUint16(pos + 28, true);
    const dataStart = pos + 30 + nameLen + extraLen;
    const compressed = this.bytes.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.compressionMethod === 0) {
      return compressed.slice();
    }
    if (entry.compressionMethod === 8) {
      return inflateRaw(compressed);
    }
    throw new Error(`不支持的 ZIP 压缩方式 (${entry.compressionMethod})：${name}`);
  }

  async readText(name: string): Promise<string | null> {
    const raw = await this.readBytes(name);
    if (!raw) return null;
    return new TextDecoder("utf-8").decode(raw);
  }
}
