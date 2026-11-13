import { avatarSprite, isSpriteArt, type AvatarView as View } from "./avatars";
import type { CharacterPrefs } from "./config";
import type { ExpressionId } from "./face";

/**
 * An avatar sheet character, drawn from the cut-out sprites. Only draws: it is handed an expression and shows the
 * drawn face that matches. No blinking and no lip-sync, because those pictures do not exist in the sheet.
 */
export function AvatarView({ character, expression, view, className }: {
  character: CharacterPrefs;
  expression: ExpressionId;
  view: View;
  className?: string;
}) {
  if (!isSpriteArt(character.art)) return null;
  const src = avatarSprite(character.art, expression, view);
  if (!src) return null;
  return (
    <img
      key={src}
      src={src}
      className={`avatar-art${className ? " " + className : ""}`}
      data-view={view}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
