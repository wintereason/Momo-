import { desktop } from "../desktop";
import type { Speaker } from "./tts";

/**
 * Give a Speaker the optional online voice. The desktop shell makes the audio (it alone holds the key) and answers
 * "no key" when none is set, in which case the Speaker simply speaks with the Windows voice. Outside the desktop app there is nothing to attach.
 */
export function attachOnlineVoice(speaker: Speaker): void {
  const d = desktop;
  if (!d?.ttsOnline) return;
  speaker.setOnline({ synth: (text, voiceId) => d.ttsOnline(text, voiceId) });
}
