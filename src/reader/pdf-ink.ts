const INK_PROBE_SIZE = 64;
let sharedInkProbeCanvas: HTMLCanvasElement | null = null;

function getInkProbeCanvas(doc: Document): HTMLCanvasElement {
  if (!sharedInkProbeCanvas || sharedInkProbeCanvas.ownerDocument !== doc) {
    sharedInkProbeCanvas = doc.createElement("canvas");
    sharedInkProbeCanvas.width = INK_PROBE_SIZE;
    sharedInkProbeCanvas.height = INK_PROBE_SIZE;
  }
  return sharedInkProbeCanvas;
}

/**
 * Checks whether a rendered PDF canvas contains visible non-white ink by downscaling
 * into a reusable 64x64 probe canvas (16 KB readback) instead of reading back the full
 * high-DPI page bitmap (~15-30 MB).
 */
export function canvasHasVisualInk(canvas: HTMLCanvasElement): boolean {
  if (canvas.width < 16 || canvas.height < 16) return false;
  try {
    const probe = getInkProbeCanvas(canvas.ownerDocument);
    const probeCtx = probe.getContext("2d", { willReadFrequently: true });
    if (!probeCtx) return true;
    probeCtx.clearRect(0, 0, INK_PROBE_SIZE, INK_PROBE_SIZE);
    probeCtx.fillStyle = "#ffffff";
    probeCtx.fillRect(0, 0, INK_PROBE_SIZE, INK_PROBE_SIZE);
    probeCtx.drawImage(canvas, 0, 0, INK_PROBE_SIZE, INK_PROBE_SIZE);
    const data = probeCtx.getImageData(0, 0, INK_PROBE_SIZE, INK_PROBE_SIZE).data;
    let nonWhite = 0;
    for (let y = 2; y < INK_PROBE_SIZE - 2; y += 1) {
      for (let x = 2; x < INK_PROBE_SIZE - 2; x += 1) {
        const off = (y * INK_PROBE_SIZE + x) * 4;
        if ((data[off + 3] ?? 255) < 32) continue;
        const r = data[off] ?? 255;
        const g = data[off + 1] ?? 255;
        const b = data[off + 2] ?? 255;
        if (r < 248 || g < 248 || b < 248) {
          nonWhite += 1;
          if (nonWhite >= 4) return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}
