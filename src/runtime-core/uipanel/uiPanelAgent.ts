import type { ScreenPort, UiReadResult } from "../shared/ports";
import { usable } from "../shared/screenText";
import type { WorldModel } from "../verifier";

/** UI & Panel agent: the structure of one window as the application itself reports it. */
export class UiPanelAgent {
  calls = 0;
  constructor(private world: WorldModel, private screen: ScreenPort) {}

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
