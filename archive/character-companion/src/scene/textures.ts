import { CanvasTexture, LinearFilter, SRGBColorSpace } from "three";
import type { EffectKind } from "./effects";
import { PLACEHOLDER_FACE, colorFor } from "../companion/expression";
import type { CompanionUiState } from "../types/runtime-events";

/** Procedural textures (drawn with the 2D canvas): floating icons, petals, soft shadows, wood, bokeh. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}
function tex(c: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

function bubble(g: CanvasRenderingContext2D, fill: string, stroke: string) {
  g.fillStyle = fill;
  g.strokeStyle = stroke;
  g.lineWidth = 5;
  g.beginPath();
  g.roundRect(8, 8, 112, 96, 28);
  g.fill();
  g.stroke();
  g.beginPath(); // tail
  g.moveTo(34, 100); g.lineTo(26, 122); g.lineTo(54, 102); g.closePath();
  g.fill();
}

function star(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string) {
  g.fillStyle = fill;
  g.strokeStyle = "#e8a400";
  g.lineWidth = 3;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
  g.stroke();
}

/** The little icon for each effect kind (same visual language as the reference sheet). */
export function effectTexture(kind: EffectKind): CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.lineJoin = "round";
  g.lineCap = "round";
  switch (kind) {
    case "mic": {
      bubble(g, "#e8f3ff", "#4aa3ff");
      g.fillStyle = "#2f86ef";
      g.beginPath(); g.roundRect(52, 24, 24, 42, 12); g.fill();
      g.strokeStyle = "#2f86ef"; g.lineWidth = 6;
      g.beginPath(); g.arc(64, 54, 24, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
      g.beginPath(); g.moveTo(64, 80); g.lineTo(64, 90); g.stroke();
      g.strokeStyle = "#7ab9ff"; g.lineWidth = 5;
      for (const d of [-1, 1]) { g.beginPath(); g.arc(64 + d * 42, 52, 12, d > 0 ? -0.8 : Math.PI - 0.8 + 1.6, d > 0 ? 0.8 : Math.PI + 0.8 - 1.6, d < 0); g.stroke(); }
      break;
    }
    case "dots": {
      bubble(g, "#ffffff", "#c7b6e8");
      g.fillStyle = "#9a86c9";
      for (const x of [40, 64, 88]) { g.beginPath(); g.arc(x, 56, 9, 0, Math.PI * 2); g.fill(); }
      break;
    }
    case "question": {
      g.fillStyle = "#ff7aa8"; g.strokeStyle = "#ffffff"; g.lineWidth = 8;
      g.font = "bold 104px 'Segoe UI', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.strokeText("?", 64, 66); g.fillText("?", 64, 66);
      break;
    }
    case "gear": {
      g.fillStyle = "#f4b942"; g.strokeStyle = "#b9801a"; g.lineWidth = 4;
      g.beginPath();
      for (let i = 0; i < 16; i++) { const a = (i * Math.PI) / 8; const r = i % 2 === 0 ? 50 : 38; g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
      g.closePath(); g.fill(); g.stroke();
      g.fillStyle = "#fff6e0"; g.beginPath(); g.arc(64, 64, 15, 0, Math.PI * 2); g.fill(); g.stroke();
      break;
    }
    case "stars": {
      star(g, 38, 70, 30, "#ffd84d"); star(g, 88, 40, 24, "#ffe680"); star(g, 92, 96, 17, "#ffd84d");
      break;
    }
    case "check": {
      g.fillStyle = "#2fbf71"; g.strokeStyle = "#ffffff"; g.lineWidth = 6;
      g.beginPath(); g.arc(64, 64, 48, 0, Math.PI * 2); g.fill(); g.stroke();
      g.lineWidth = 12;
      g.beginPath(); g.moveTo(40, 66); g.lineTo(58, 84); g.lineTo(90, 46); g.stroke();
      break;
    }
    case "half": {
      g.fillStyle = "#ffcf5c"; g.strokeStyle = "#ffffff"; g.lineWidth = 6;
      g.beginPath(); g.arc(64, 64, 48, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = "#7a5200"; g.font = "bold 64px 'Segoe UI', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("½", 64, 68);
      break;
    }
    case "sweat": {
      g.fillStyle = "#8fd0ff"; g.strokeStyle = "#4aa3ff"; g.lineWidth = 5;
      g.beginPath(); g.moveTo(64, 14); g.bezierCurveTo(100, 62, 96, 108, 64, 112); g.bezierCurveTo(32, 108, 28, 62, 64, 14); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = "rgba(255,255,255,0.8)"; g.beginPath(); g.ellipse(52, 78, 7, 12, 0.3, 0, Math.PI * 2); g.fill();
      break;
    }
    case "exclaim": {
      g.fillStyle = "#ffb84d"; g.strokeStyle = "#ffffff"; g.lineWidth = 6;
      g.beginPath(); g.arc(64, 64, 48, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = "#ffffff"; g.beginPath(); g.roundRect(56, 28, 16, 44, 8); g.fill();
      g.beginPath(); g.arc(64, 90, 9, 0, Math.PI * 2); g.fill();
      break;
    }
    case "warning": {
      g.fillStyle = "#ffd23f"; g.strokeStyle = "#b88700"; g.lineWidth = 6;
      g.beginPath(); g.moveTo(64, 14); g.lineTo(114, 106); g.lineTo(14, 106); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = "#5a4300"; g.beginPath(); g.roundRect(58, 44, 12, 34, 6); g.fill();
      g.beginPath(); g.arc(64, 90, 7, 0, Math.PI * 2); g.fill();
      break;
    }
    case "zzz": {
      g.fillStyle = "#8d7fe0"; g.strokeStyle = "#ffffff"; g.lineWidth = 7; g.textAlign = "center"; g.textBaseline = "middle";
      g.font = "bold 84px 'Segoe UI', sans-serif"; g.strokeText("Z", 46, 82); g.fillText("Z", 46, 82);
      g.font = "bold 60px 'Segoe UI', sans-serif"; g.strokeText("Z", 84, 50); g.fillText("Z", 84, 50);
      g.font = "bold 40px 'Segoe UI', sans-serif"; g.strokeText("z", 108, 22); g.fillText("z", 108, 22);
      break;
    }
    case "slash": {
      g.fillStyle = "#9a9aa8"; g.beginPath(); g.roundRect(50, 22, 28, 46, 14); g.fill();
      g.strokeStyle = "#9a9aa8"; g.lineWidth = 7; g.beginPath(); g.arc(64, 58, 26, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
      g.strokeStyle = "#ee4b4b"; g.lineWidth = 11; g.beginPath(); g.moveTo(26, 18); g.lineTo(102, 108); g.stroke();
      break;
    }
  }
  return tex(c);
}

/** A soft pink petal with a notch, on transparency. */
export function petalTexture(): CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grad = g.createLinearGradient(0, 8, 0, 56);
  grad.addColorStop(0, "#ffe3ee"); grad.addColorStop(1, "#ff9fc0");
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(32, 58);
  g.bezierCurveTo(4, 44, 6, 14, 26, 8);
  g.lineTo(32, 16); g.lineTo(38, 8);
  g.bezierCurveTo(58, 14, 60, 44, 32, 58);
  g.closePath(); g.fill();
  return tex(c);
}

/** A soft round blob used for contact shadows, glow and bokeh. */
export function softCircleTexture(inner: string, outer = "rgba(255,255,255,0)"): CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, inner); grad.addColorStop(1, outer);
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return tex(c);
}

/** Polished wood with long grain lines, for the table top. */
export function woodTexture(): CanvasTexture {
  const [c, g] = canvas(512, 256);
  const base = g.createLinearGradient(0, 0, 0, 256);
  base.addColorStop(0, "#c98f5a"); base.addColorStop(1, "#a9693a");
  g.fillStyle = base; g.fillRect(0, 0, 512, 256);
  let seed = 11;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = `rgba(${90 + r() * 40}, ${50 + r() * 30}, 25, ${0.08 + r() * 0.14})`;
    g.lineWidth = 1 + r() * 2.4;
    const y = r() * 256;
    g.beginPath(); g.moveTo(0, y);
    g.bezierCurveTo(150, y + (r() - 0.5) * 14, 350, y + (r() - 0.5) * 14, 512, y + (r() - 0.5) * 10);
    g.stroke();
  }
  const gloss = g.createLinearGradient(0, 0, 512, 0);
  gloss.addColorStop(0, "rgba(255,255,255,0)"); gloss.addColorStop(0.35, "rgba(255,240,225,0.22)"); gloss.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gloss; g.fillRect(0, 0, 512, 256);
  return tex(c);
}

/** A warm sunset wash behind everything, like the reference's bokeh garden. */
export function skyTexture(): CanvasTexture {
  const [c, g] = canvas(256, 256);
  const grad = g.createRadialGradient(150, 90, 10, 128, 128, 170);
  grad.addColorStop(0, "rgba(255,224,200,0.75)"); grad.addColorStop(0.55, "rgba(247,190,222,0.38)"); grad.addColorStop(1, "rgba(200,170,235,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  return tex(c);
}

/** The 2D stand-in when a character has no sprite yet (same look as the CSS placeholder). */
export function placeholderCharacterTexture(characterId: string, state: CompanionUiState, label: string): CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = colorFor(characterId);
  g.beginPath(); g.ellipse(128, 150, 92, 98, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "rgba(0,0,0,0.08)"; g.beginPath(); g.ellipse(128, 215, 80, 22, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#2a1d35"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "600 30px 'Segoe UI', sans-serif"; g.fillText(PLACEHOLDER_FACE[state], 128, 128);
  g.font = "700 26px 'Segoe UI', sans-serif"; g.fillText(label, 128, 170);
  return tex(c);
}
