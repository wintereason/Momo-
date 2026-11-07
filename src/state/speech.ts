import type { RuntimeEvent } from "../types/runtime-events";
import { speechText } from "../voice/tts";

/**
 * What Momo says aloud for each thing the agent does: it announces what it is about to do, confirms what it verified,
 * explains what failed, and reads out the options when it has to ask which one. Pure and tested; the bar speaks what this returns.
 * Looking things up and thinking are silent: only steps that DO something are announced.
 */
export interface Spoken {
  text: string;
  /** true = say it after what is already being said; false = replace it */
  queue: boolean;
}

/** "Folder: Projects" -> "Projects"; the folder it is in comes from its full path: "Projects, in Documents". */
export function spokenOption(label: string, detail: string | undefined, index: number): string {
  const name = label.replace(/^(File|Folder):\s*/i, "");
  const parts = (detail ?? "").split(/[\\/]/).filter(Boolean);
  const where = parts.length >= 2 ? parts[parts.length - 2].replace(/:$/, " drive") : "";
  return `${index + 1}: ${name}${where ? `, in ${where}` : ""}`;
}

export function speechFor(e: RuntimeEvent): Spoken | null {
  switch (e.type) {
    case "task.state":
      if (e.state === "working" && e.speak && e.message) return { text: e.message, queue: false };
      if (e.state === "partial_success" && e.message) return { text: e.message, queue: true };
      return null;
    case "task.completed":
      return { text: e.summary, queue: true };
    case "task.failed":
      return { text: `I couldn't do that. ${e.summary}`, queue: true };
    case "task.confirmation_required":
      return { text: e.summary, queue: false };
    case "task.clarification_required": {
      if (e.options && e.options.length > 0) {
        const list = e.options.map((o, i) => spokenOption(o.label, o.detail, i)).join(". ");
        return { text: `I found ${e.options.length} matches. ${list}. Which one?`, queue: false };
      }
      return { text: e.question, queue: false };
    }
    case "task.answer":
      return { text: e.text, queue: true };
    default:
      return null;
  }
}

/** Longer replies are shortened for the ear (the full text stays on screen). */
export const forSpeech = (s: Spoken): Spoken => ({ ...s, text: speechText(s.text, 320) });
