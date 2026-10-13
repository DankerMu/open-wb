/**
 * Issue #1257 the code points a path or a file name a client supplies may not hold, one list for
 * the two places that judge one: the attachment paths of a prompt (message-attachments「prompt
 * 携带附件」condition 1) and the name of an upload (workspaces「文件上传」step 5) — so a file that
 * can be uploaded can also be attached. Lexical only; nothing here decides what is inside the
 * sandbox (core/sandbox does).
 */

/**
 * True when `text` holds one of: the controls U+0000–U+001F and U+007F; the line breaks U+0085,
 * U+2028 and U+2029; the twelve bidirectional controls U+061C, U+200E, U+200F, U+202A–U+202E and
 * U+2066–U+2069. All of them are single UTF-16 code units, so the text is read unit by unit.
 */
export function hasRefusedCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isRefused(text.charCodeAt(index))) {
      return true;
    }
  }
  return false;
}

function isRefused(unit: number): boolean {
  if (unit <= 0x1f || unit === 0x7f || unit === 0x85 || unit === 0x61c) {
    return true;
  }
  if (unit === 0x200e || unit === 0x200f || unit === 0x2028 || unit === 0x2029) {
    return true;
  }
  return (unit >= 0x202a && unit <= 0x202e) || (unit >= 0x2066 && unit <= 0x2069);
}
