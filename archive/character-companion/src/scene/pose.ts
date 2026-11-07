import type { CompanionUiState } from "../types/runtime-events";

/**
 * How the character moves for each semantic state. Pure functions of time, so the same motion drives a
 * 2D sprite, a billboard in the 3D scene, or the root of a .glb model. Units are scene units (about 1 = the
 * character's height). Presentation only: the motion never decides what the agent does or claims.
 */
export interface Pose {
  x: number;
  y: number;
  /** uniform scale around 1 */
  scale: number;
  /** vertical squash/stretch (1 = none), for breathing and hops */
  squash: number;
  /** tilt in radians */
  rotZ: number;
}

export const REST_POSE: Pose = { x: 0, y: 0, scale: 1, squash: 1, rotZ: 0 };

const breathe = (t: number, speed: number, amount: number) => Math.sin(t * speed) * amount;

/**
 * @param t seconds since the scene started (drives the continuous motion)
 * @param since seconds since the current state began (drives one-off flourishes like the success hop)
 * @param reduceMotion damps everything to a barely-there breath
 */
export function poseFor(state: CompanionUiState, t: number, since: number, reduceMotion = false): Pose {
  const k = reduceMotion ? 0.15 : 1;
  const p: Pose = { ...REST_POSE };

  switch (state) {
    case "idle":
      p.y = breathe(t, 1.6, 0.010);
      p.squash = 1 + breathe(t, 1.6, 0.012);
      break;
    case "listening": // attentive: leans in slightly and pulses
      p.y = breathe(t, 5, 0.008);
      p.scale = 1.03 + breathe(t, 5, 0.012);
      p.rotZ = -0.05;
      break;
    case "transcribing":
      p.y = breathe(t, 3, 0.008);
      p.rotZ = breathe(t, 2, 0.02);
      break;
    case "thinking": // pondering: slow side-to-side
      p.rotZ = breathe(t, 1.3, 0.05);
      p.y = breathe(t, 1.3, 0.006);
      break;
    case "asking": // curious head tilt
      p.rotZ = 0.11 + breathe(t, 2, 0.015);
      p.y = breathe(t, 2, 0.008);
      break;
    case "working": // focused and a little leaning forward, small quick motion
      p.rotZ = 0.03;
      p.y = breathe(t, 7, 0.007);
      p.x = breathe(t, 3.5, 0.006);
      break;
    case "success": { // a celebratory hop for the first moments, then settles
      const hop = since < 1.4 ? Math.abs(Math.sin(since * 6)) * Math.exp(-since * 1.2) * 0.16 : 0;
      p.y = hop + breathe(t, 2, 0.006);
      p.squash = 1 + (hop > 0 ? 0.03 : 0) + breathe(t, 2, 0.008);
      break;
    }
    case "partial_success":
      p.y = breathe(t, 1.8, 0.008);
      p.rotZ = 0.03;
      break;
    case "sorry": // lowered head, slumped
      p.y = -0.035 + breathe(t, 1.2, 0.004);
      p.rotZ = -0.04;
      p.squash = 0.98;
      break;
    case "blocked": // alert and still
      p.y = breathe(t, 1, 0.003);
      p.scale = 1.01;
      break;
    case "error":
      p.x = since < 0.6 ? Math.sin(since * 38) * 0.012 * (1 - since / 0.6) : 0; // a brief flinch
      p.y = -0.02;
      break;
    case "sleeping": // slow breathing, resting low
      p.y = -0.06 + breathe(t, 0.9, 0.006);
      p.squash = 0.97 + breathe(t, 0.9, 0.012);
      p.rotZ = 0.03;
      break;
    case "disabled":
      p.y = 0;
      break;
  }
  return {
    x: p.x * k,
    y: reduceMotion ? p.y * 0.3 : p.y,
    scale: 1 + (p.scale - 1) * k,
    squash: 1 + (p.squash - 1) * k,
    rotZ: p.rotZ * (reduceMotion ? 0.4 : 1),
  };
}
