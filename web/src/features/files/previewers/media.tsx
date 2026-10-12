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
 * same file, for 刷新 and a second click on the same row: each gets a new element and no
 * message. For those two it also hands in another address, the file's own followed by `&v=<n>`
 * with an n it has not used since the page loaded (`immediatePreview`); nothing here builds or
 * reads that parameter.
 * Walked in Chromium and Firefox against a real server (`file` answered 206 with `no-store`):
 * after 刷新 a clip that was playing is a new element, back at its start and not playing; a
 * request for the new address reaches the server, and a file replaced on disk just before the
 * click is what the element gets.
 * An address fetched before is another matter, and the reason for `v`. In the same walk a new
 * element given one, some seconds after that fetch, sent no request and held what the fetch had
 * got, the file having been replaced in between. A first selection carries no `v`, so selecting
 * another file and coming back is that case. Walked before the address changed, Chromium only:
 * still no request about 40 seconds after the fetch, a new one about 70 seconds after. The
 * mechanism was not looked into.
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
