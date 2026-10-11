/**
 * Web page previewer (html / htm): the rendered view is a frame whose address is the issued token's
 * `base` followed by the file's path, each segment percent-encoded on its own; 查看源码 / 渲染视图
 * switches to the source view the caller hands in. This module builds no host or port, makes no
 * request, calls no hook and keeps no state: token, view and reload count are the host's.
 *
 * What the frame is given, and how far each statement is backed:
 * - The address is `base` + path and nothing else (tests pin the attribute). `base` is by default
 *   the same host on the preview port (read from the server code); with a configured preview
 *   origin it is that value, and whether that differs from the main site is the deployment's to
 *   decide (not verified here).
 * - `sandbox` is exactly `allow-scripts allow-forms allow-modals` (tests pin the attribute; jsdom
 *   shows the value only, not what a browser does with it). The file's content is never given to
 *   the frame as an inline document: it only ever arrives through the address.
 * - The server sends the same three tokens as a CSP `sandbox` response header for this document
 *   (read from the server code and pinned by its tests). What a browser enforces from the header
 *   and the attribute is not established by anything in this directory.
 *
 * The path is data: no trimming, no normalising, no special case for dot segments or a leading
 * slash; the attribute is the encoded path as given. How a browser resolves such an address and
 * what the listener answers for it is theirs to decide (not tested here).
 * The frame is keyed by `reload` alone, so a renewed token with the same `base` leaves the node
 * (and its document) alone, a different `base` changes the address of the same node, and 刷新 gets
 * a new node. A token that failed to issue shows its message in place; the source view and the
 * header's download link do not depend on it.
 */
import { Button } from "@/components/ui/button";
import { REQUEST_FAILED_MESSAGE } from "../../../lib/api.js";
import { ALERT_BOX, STATUS_TEXT } from "../columns.js";
import type { Previewer } from "./index.js";

type Web = NonNullable<Parameters<Previewer>[0]["web"]>;

function RenderedView({ name, path, reload, token }: { name: string } & Web) {
  if (token.status === "error") {
    return <Failure message={token.message} />;
  }
  if (token.status !== "ready") {
    return (
      <p className={`${STATUS_TEXT} px-4 pt-3`} role="status">
        正在加载预览…
      </p>
    );
  }
  return (
    <iframe
      className="min-h-0 w-full flex-1 border-0 bg-white"
      key={reload}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-forms allow-modals"
      src={token.base + path.split("/").map(encodeURIComponent).join("/")}
      title={name}
    />
  );
}

export function WebPreviewer({ name, web }: { name: string; web?: Web | undefined }) {
  if (!web) {
    return <Failure message={REQUEST_FAILED_MESSAGE} />;
  }
  const showSource = web.view === "source";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 justify-end px-4 pt-2">
        <Button
          onClick={() => web.onViewChange(showSource ? "rendered" : "source")}
          type="button"
          variant="secondary"
        >
          {showSource ? "渲染视图" : "查看源码"}
        </Button>
      </div>
      {showSource ? web.source : <RenderedView name={name} {...web} />}
    </div>
  );
}

function Failure({ message }: { message: string }) {
  return (
    <p className={`${ALERT_BOX} mx-4 mt-3 text-[12px]`} role="alert">
      {message}
    </p>
  );
}
