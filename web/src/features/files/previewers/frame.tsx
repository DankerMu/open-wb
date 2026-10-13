/**
 * The previewers whose content a frame loads from the preview origin: web pages (html / htm), and
 * PDF and office documents (docx / xlsx / pptx). A frame's address is a prefix from the issued
 * token (`base`, or `officeBase` for an office document) followed by the file's path, each segment
 * percent-encoded on its own. This module builds no host or port, makes no request and calls no
 * hook that reaches the token: token, view and reload count are the host's. The only state kept
 * here is whether a document's frame has fired `load`.
 *
 * The path is data: no trimming, no normalising, no special case for dot segments or a leading
 * slash; the attribute is the encoded path as given. How a browser resolves such an address and
 * what the listener answers for it is theirs to decide (not tested here).
 * A token that failed to issue shows its message in place; the header's download link does not
 * depend on it.
 *
 * Web page: 查看源码 / 渲染视图 switches to the source view the caller hands in. What its frame is
 * given, and how far each statement is backed:
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
 * - The frame is keyed by `reload` alone, so a renewed token with the same `base` leaves the node
 *   (and its document) alone, a different `base` changes the address of the same node, and 刷新
 *   gets a new node.
 *
 * PDF and office document: the frame has exactly `class`, `src` and `title`, and no `sandbox`
 * attribute (tests pin the attribute set). It embeds a file the user or the agent put in the
 * workspace, so what stands between that file and the main site is listed here with its backing:
 * - No attribute-level restriction applies to this frame: pop-ups, top-level navigation, downloads
 *   and forms are whatever the browser's viewer allows. How the built-in viewer treats scripts and
 *   links inside a PDF, and whether following a link sends the token-bearing address as a referrer,
 *   is not tested.
 * - The address comes from the token response only (`base` for a PDF, `officeBase` for an office
 *   document; tests pin both). The listener answers a `pdf` name with `application/pdf` and
 *   `nosniff`, and an office document with the converted PDF or a plain-text failure page, none
 *   of them with a CSP `sandbox` (read from the server code, pinned by its tests). So the framed
 *   document has the preview origin as its real origin, not an opaque one (derived from the code;
 *   seen in the walk for issue 1094 on Chromium 151, where the frame's `self.origin` was the
 *   preview origin for a PDF and for a failure page, while Firefox 153 reported its viewer's own
 *   origin for a PDF).
 * - That origin differs from the main site's by port in the default deployment (read from the
 *   server code): another origin, the same site. Whether a file whose bytes are HTML but whose
 *   name ends in `pdf` is kept from running as HTML by the type-by-extension rule plus `nosniff`
 *   is not tested.
 * - Before any frame is built, in this order: the entry's size over the token's
 *   `documentMaxBytes` (skipped when the entry has no size, issue 1372: the frame then shows whatever
 *   the preview origin answers), an office document while `officeAvailable` is false, and
 *   `navigator.pdfViewerEnabled === false` (for both kinds: an office document is shown as a PDF
 *   too). Each shows its line and builds no frame. `undefined` (a browser without the property)
 *   builds the frame.
 * - The frame and, for an office document, the 正在转换文档… layer over it live in one component
 *   keyed by `reload` and the address: 刷新 or a different prefix gets a new node and the layer
 *   again; a renewed token with the same prefix leaves the node alone. The layer goes when the
 *   frame fires `load`, and nothing else removes it. A PDF has no layer.
 * - Whether `load` fires is the browser's doing; jsdom never fires it, so the tests dispatch it.
 *   Measured in the walk for issue 1094 (macOS; Chromium 151 in the new headless mode and
 *   Playwright's Firefox 153 with its PDF viewer switched on; the converter was a stand-in, not
 *   LibreOffice):
 *   `load` fired for a PDF in the built-in viewer, for a converted document and for the 502
 *   failure page, and in the two office cases the layer went with it. Other engines and versions
 *   were not walked.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { REQUEST_FAILED_MESSAGE } from "../../../lib/api.js";
import { ALERT_BOX, STATUS_TEXT } from "../columns.js";
import { EmptyState } from "../empty-state.js";
import { withSize } from "../file-meta.js";
import type { Previewer } from "./index.js";

type Web = NonNullable<Parameters<Previewer>[0]["web"]>;
type Doc = NonNullable<Parameters<Previewer>[0]["doc"]>;
type Token = Web["token"];

const FRAME = "min-h-0 w-full flex-1 border-0 bg-white";

/** `prefix` as issued, then the path with each segment encoded on its own. */
function address(prefix: string, path: string): string {
  return prefix + path.split("/").map(encodeURIComponent).join("/");
}

/** What stands in for the frame while there is no usable token. */
function WithoutToken({ token }: { token: Exclude<Token, { status: "ready" }> }) {
  if (token.status === "error") {
    return <Failure message={token.message} />;
  }
  return (
    <p className={`${STATUS_TEXT} px-4 pt-3`} role="status">
      正在加载预览…
    </p>
  );
}

function RenderedView({ name, path, reload, token }: { name: string } & Web) {
  if (token.status !== "ready") {
    return <WithoutToken token={token} />;
  }
  return (
    <iframe
      className={FRAME}
      key={reload}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-forms allow-modals"
      src={address(token.base, path)}
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

/** The line shown instead of a frame, or `null` when the frame may be built. Order is the spec's. */
function refusal(doc: Doc, token: Extract<Token, { status: "ready" }>): string | null {
  if (doc.size !== undefined && doc.size > token.documentMaxBytes) {
    return "文件过大，无法预览";
  }
  if (doc.office && !token.officeAvailable) {
    return "服务器未启用文档转换，请下载后查看";
  }
  // Only an explicit false: a browser without the property (`undefined`) gets the frame.
  if (navigator.pdfViewerEnabled === false) {
    return "此浏览器不支持内嵌 PDF 预览，请下载后查看";
  }
  return null;
}

export function DocumentPreviewer({ name, doc }: { name: string; doc?: Doc | undefined }) {
  if (!doc) {
    return <Failure message={REQUEST_FAILED_MESSAGE} />;
  }
  const { token } = doc;
  if (token.status !== "ready") {
    return <WithoutToken token={token} />;
  }
  const refused = refusal(doc, token);
  if (refused !== null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState description={withSize(name, doc.size)} title={refused} />
      </div>
    );
  }
  const src = address(doc.office ? token.officeBase : token.base, doc.path);
  return (
    <DocumentFrame converting={doc.office} key={`${doc.reload} ${src}`} name={name} src={src} />
  );
}

/**
 * The frame of a PDF or an office document. `converting`: until the frame fires `load`, a layer
 * saying so covers it (the frame is in the document underneath, loading).
 */
function DocumentFrame({
  converting,
  name,
  src,
}: {
  converting: boolean;
  name: string;
  src: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <iframe className={FRAME} onLoad={() => setLoaded(true)} src={src} title={name} />
      {converting && !loaded ? (
        <p
          className={`${STATUS_TEXT} absolute inset-0 flex items-center justify-center bg-(--wb-bg-primary)`}
          role="status"
        >
          正在转换文档…
        </p>
      ) : null}
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
