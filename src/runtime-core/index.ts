// Entry point bundled into electron/runtime.cjs (see scripts/build-runtime.mjs).
import type { RuntimeEvent } from "../types/runtime-events";
import { buildAiConfig, createAiService, LlmClient, Session, type AiConfig, type UsageStore } from "./orchestrator";
import { focusedFieldIsPassword, nodeInput, scanTargets, focusedField, focusField, readBack, planTarget, verifyInsertion, describeField } from "./action";
import { nodeApps, nodeLaunch } from "./apps";
import { nodeFs, nodeScreen, nodeWindows } from "./shared/nodePorts";
import type { ActionPort, ForegroundPort, PointerPort } from "./shared/ports";

export function createRuntime(opts: {
  emit(e: RuntimeEvent): void;
  selfPids: () => number[];
  act?: ActionPort;
  foreground?: ForegroundPort;
  /** the AI brain: its settings (re-read on every use, so .env edits apply) and where the daily count is kept */
  ai?: { config: () => AiConfig; usage: UsageStore };
  /** how long the shadow cursor gets to glide to a control before Momo acts (0 when it is switched off) */
  cursorLeadMs?: () => number;
  /** the real mouse and keyboard, or undefined while human-like control is off */
  pointer?: () => PointerPort | undefined;
}): Session {
  const ai = opts.ai ? createAiService(new LlmClient({ config: opts.ai.config, usage: opts.ai.usage }), opts.ai.config) : undefined;
  return new Session({
    fs: nodeFs, win: nodeWindows, screen: nodeScreen, input: nodeInput, apps: nodeApps, launch: nodeLaunch,
    emit: opts.emit, selfPids: opts.selfPids, act: opts.act, foreground: opts.foreground, ai, cursorLeadMs: opts.cursorLeadMs, pointer: opts.pointer,
  });
}

export { nodeFs, scanTargets, focusedField, focusField, readBack, planTarget, verifyInsertion, describeField, focusedFieldIsPassword, LlmClient, Session, buildAiConfig, createAiService, nodeApps, nodeInput, nodeLaunch, nodeScreen, nodeWindows };
