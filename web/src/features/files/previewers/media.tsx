/**
 * Audio and video previewer. `content` is the address of the file itself (`fileUrl`), handed to
 * the element as is: the browser fetches it on its own (in the one engine walked, Chromium, as
 * `Range` requests answered 206); nothing here reads the bytes and nothing is allocated, so
 * unmounting releases nothing beyond the element going away. Never autoplays.
 * An `error` event of the element replaces the player with 无法播放该文件; no other request is
 * made to find out why. Walked: a file whose body is not media. Read from the HTML standard, not
 * walked: a 401 / 404 / 416 answer and a format the browser rejects end the same way; a format it
 * plays badly without reporting an error shows no message.
 * The failure lasts as long as this mount. The caller remounts it for another file and, on the
 * same file, for 刷新 and a second click on the same row: each gets a new element with the same
 * address and no message.
 * Walked in Chromium only: after 刷新 a clip that was playing is a new element, back at its start
 * and not playing. Whether a new element asks the server again is the browser's call. In that
 * walk one remounted within about 40 seconds of the previous fetch of the same address sent no
 * request and ended as the previous one had, a file replaced on disk in between included; one
 * remounted about 70 seconds after fetched again. The mechanism was not looked into.
 * A 401 answer is one more `error` among the others: the event carries no status, so nothing here
 * can tell the authentication guard, and nothing asks.
 */
import { useState } from "react";
import { previewKind } from "./kind.js";

export function MediaPreviewer({ name, content }: { name: string; content: string }) {
  const [failed, setFailed] = useState(false);
  const fail = () => setFailed(true);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-(--wb-bg-secondary) p-6">
      {failed ? (
        <p className="text-[13px] text-muted-foreground">无法播放该文件</p>
      ) : previewKind(name) === "video" ? (
        // biome-ignore lint/a11y/useMediaCaption: 空间里的任意文件，没有随它的字幕轨可挂。
        <video
          className="max-h-full max-w-full rounded-[8px]"
          controls
          onError={fail}
          preload="metadata"
          src={content}
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: 同上。
        <audio className="max-w-full" controls onError={fail} preload="metadata" src={content} />
      )}
    </div>
  );
}
