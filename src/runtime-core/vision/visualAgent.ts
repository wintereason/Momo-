import type { OcrResult, ScreenPort } from "../shared/ports";
import { cleanScreenText } from "../shared/screenText";
import type { WorldModel } from "../verifier";

/** Visual perception agent: a screenshot of one window read by the local OCR engine. */
export class VisualAgent {
  calls = 0;
  constructor(private world: WorldModel, private screen: ScreenPort) {}

  async read(hwnd: number): Promise<OcrResult> {
    this.calls++;
    const r = await this.screen.ocr(hwnd);
    if (!r.ok) return r;
    const lines = r.lines.map(cleanScreenText).filter((l) => l.length >= 2).slice(0, 80);
    this.world.upsert({
      id: `screen:${hwnd}`, type: "screen", parentId: `window:${hwnd}`,
      props: { lines: lines.length },
      // text recognised from pixels can be wrong: lower confidence than UI Automation
      source: "ocr", confidence: 0.7,
    });
    // a blank capture (common for GPU-drawn apps) is "nothing readable", not a successful read of nothing
    if (lines.length === 0) return { ok: false, reason: "nothing readable was found in the screenshot" };
    return { ok: true, lines };
  }
}
