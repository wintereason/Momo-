import { AvatarView } from "./AvatarView";
import { Momo } from "./Momo";
import { isSpriteArt } from "./avatars";
import type { CharacterPrefs } from "./config";
import type { ExpressionId } from "./face";
import type { MouthSync } from "./speechMouth";
import { SpeechCloud, type Cloud } from "./SpeechCloud";

/** Momo's avatar (whichever the user chose) with its speech cloud. A reusable stage for any screen that makes Momo talk. */
export function AvatarStage({ character, expression, mouth, cloud, view = "expanded", className }: {
  character: CharacterPrefs;
  expression: ExpressionId;
  mouth: MouthSync;
  cloud: Cloud | null;
  view?: "compact" | "expanded";
  className?: string;
}) {
  return (
    <div className={`avatar-stage${className ? " " + className : ""}`} aria-label="Momo, your teacher">
      {isSpriteArt(character.art)
        ? <AvatarView character={character} expression={expression} view={view} mouth={mouth} className="stage-art" />
        : <Momo appearance={character} expression={expression} mouth={mouth} view={view} className="stage-art" />}
      <SpeechCloud cloud={cloud} className="stage-cloud" />
    </div>
  );
}
