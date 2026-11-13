import type { ScreenPort, UiNode, UiReadResult } from "../shared/ports";
import { boxKey, usable } from "../shared/screenText";
import type { WorldModel } from "../verifier";
import { understand, withPicture, type Understanding, type UnderstandCtx } from "./understand";

/** The controls worth understanding one by one (a list's many rows are not). */
const COMPONENT_TYPES = new Set(["Button", "SplitButton", "Edit", "ComboBox", "CheckBox", "RadioButton", "MenuItem", "TabItem", "Hyperlink", "Slider"]);

export interface Component { node: UiNode; u: Understanding }

/** UI & Panel agent: the structure of one window as the application itself reports it. */
export class UiPanelAgent {
  calls = 0;
  constructor(private world: WorldModel, private screen: ScreenPort) {}

  /** The taskbar's buttons (Start, apps) with their boxes, if this PC can say. */
  async taskbar(): Promise<UiNode[] | null> {
    try { return (await this.screen.taskbar?.()) ?? null; } catch { return null; }
  }

  /**
   * What every control in a window is FOR (see understand.ts): metadata first, then the label, then the surroundings. Each conclusion is
   * kept in the World Model with where it came from and how sure it is, and it is replaced the next time the window is read.
   */
  understandAll(hwnd: number, ctx: { process: string; title: string }, items: UiNode[]): Component[] {
    const full: UnderstandCtx = { process: ctx.process, title: ctx.title, items };
    const out: Component[] = items.filter((n) => COMPONENT_TYPES.has(n.type) && !n.offscreen && !!n.rect).map((node) => ({ node, u: understand(node, full) }));
    this.world.prune((e) => e.id.startsWith(`component:${hwnd}:`));
    for (const c of out.slice(0, 120)) {
      this.world.upsert({
        id: `component:${hwnd}:${boxKey(c.node) || c.node.rid || c.node.name}`, type: "control", parentId: `window:${hwnd}`,
        props: { name: c.node.name, type: c.node.type, kind: c.u.kind, purpose: c.u.purpose, scope: c.u.scope, effect: c.u.effect, uncertain: c.u.uncertain, basis: c.u.basis },
        source: c.u.basis.includes("vision") ? "vision" : c.u.basis.includes("ocr") ? "ocr" : "uia", confidence: c.u.confidence,
      });
    }
    return out;
  }

  /**
   * Metadata was not enough: read the control's own picture (its box, with the text inside it) with the local OCR. This stays on this PC.
   * Returns the new understanding, with the picture's evidence added (and weighed lower than metadata).
   */
  async lookCloser(hwnd: number, node: UiNode, u: Understanding): Promise<{ u: Understanding; text: string[]; tried: boolean }> {
    if (!node.rect || !this.screen.ocrRegion) return { u, text: [], tried: false };
    const r = node.rect;
    const pad = 6;
    const res = await this.screen.ocrRegion(hwnd, { l: r.l - pad, t: r.t - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
    const text = res.ok ? res.lines.map((l) => l.trim()).filter(Boolean).slice(0, 6) : [];
    const next = withPicture(u, node, { ocr: text });
    this.world.upsert({
      id: `component:${hwnd}:${boxKey(node) || node.rid || node.name}`, type: "control", parentId: `window:${hwnd}`,
      props: { name: node.name, type: node.type, kind: next.kind, purpose: next.purpose, scope: next.scope, effect: next.effect, uncertain: next.uncertain, basis: next.basis },
      source: "ocr", confidence: next.confidence,
    });
    return { u: next, text, tried: true };
  }

  /** A small picture of one control, in memory only (it goes nowhere unless the user agrees to a visual AI looking at it). */
  async picture(hwnd: number, node: UiNode): Promise<{ png: string } | { reason: string }> {
    if (!node.rect || !this.screen.capture) return { reason: "taking a picture of a control isn't available here" };
    const r = node.rect;
    const pad = 4;
    const c = await this.screen.capture(hwnd, { l: r.l - pad, t: r.t - pad, w: Math.min(r.w + pad * 2, 900), h: Math.min(r.h + pad * 2, 600) });
    return c.ok ? { png: c.png } : { reason: c.reason };
  }

  async read(hwnd: number): Promise<UiReadResult> {
    this.calls++;
    const r = await this.screen.readUi(hwnd);
    if (!r.ok) return r;
    const items = usable(r.items); // password fields never get past here
    this.world.upsert({
      id: `control:${hwnd}`, type: "control", parentId: `window:${hwnd}`,
      props: { elements: items.length, truncated: r.truncated },
      source: "uia", confidence: 0.9,
    });
    return { ok: true, items, truncated: r.truncated, hadPasswordField: r.items.some((n) => n.password) };
  }
}
