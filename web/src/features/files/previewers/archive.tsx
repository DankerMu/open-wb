/**
 * Archive previewer: the member list of a zip / tar / gz, as text. The caller hands over `load`,
 * one listing request for the selected file; this module calls it once per `load` it is given, with
 * a signal of its own that is aborted when the previewer goes away or a new `load` arrives (刷新,
 * a second click on the same row). What is shown is the last result that settled, whichever `load`
 * it came from: the list, the empty-archive line or a failure text. While the current `load` has
 * not settled the reading line follows it (on the first listing the reading line is all there is);
 * the next result, a failure included, replaces it, and a result that arrives after its signal was
 * aborted is dropped.
 * Member names are data: rendered as text and as the `title`, never trimmed, normalised or turned
 * into an address. Nothing in the table can be clicked and this module has no way to ask for a
 * member or for the archive itself; downloading the whole archive is the header link's job.
 * Failures: the envelope code `preview_unsupported` reads 无法读取该压缩包 (by code, not by
 * status); a 401 is left to the authentication guard and settles nothing, so the previous result
 * (if any) and the reading line stay; anything else shows the envelope message or the safe
 * request-failed text.
 * Not claimed: that a listing describes a file inside the workspace. The route behind `load` has
 * the known read window recorded in design D22「已知残余」, which this module neither closes nor
 * widens (read from the code, not measured).
 * `preview-archive` is a hook for tests and the UI walk to select by; none in the repository does yet.
 */
import { useEffect, useState } from "react";
import { Icon } from "../../../components/icon.js";
import { ApiError, REQUEST_FAILED_MESSAGE } from "../../../lib/api.js";
import { ALERT_BOX, STATUS_TEXT } from "../columns.js";
import { errorMessage, isUnauthorized } from "../errors.js";
import { formatSize } from "../file-meta.js";
import type { PreviewState } from "../types.js";

type ArchiveLoad = Extract<PreviewState, { status: "archive" }>["load"];
type Listing = Awaited<ReturnType<ArchiveLoad>>;
type Entry = Listing["entries"][number];

/** 最后一次落定的结果与它所属的 `load`；`load` 换了之后它仍显示，直到新的一次落定。 */
type Settled = { load: ArchiveLoad } & ({ listing: Listing } | { message: string });

function failureText(error: unknown): string {
  return error instanceof ApiError && error.code === "preview_unsupported"
    ? "无法读取该压缩包"
    : errorMessage(error);
}

/** 目录不显示大小（zip 给 0、tar 可给别的数）；归档没写大小时是 `—`。 */
function sizeText(entry: Entry): string {
  if (entry.type === "dir") return "";
  return entry.size === null ? "—" : formatSize(entry.size);
}

export function ArchivePreviewer({ load }: { load?: ArchiveLoad | undefined }) {
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    const { signal } = controller;
    load(signal).then(
      (listing) => {
        if (!signal.aborted) setSettled({ load, listing });
      },
      (error: unknown) => {
        // 中止后的拒绝不是失败；401 交给认证守卫，这里不落定：上一次的结果与读取行都留着。
        if (signal.aborted || isUnauthorized(error)) return;
        setSettled({ load, message: failureText(error) });
      },
    );
    return () => controller.abort();
  }, [load]);

  if (!load) {
    return <Failure message={REQUEST_FAILED_MESSAGE} />;
  }
  return (
    <>
      {settled ? <Result settled={settled} /> : null}
      {settled?.load === load ? null : (
        <p className={`${STATUS_TEXT} px-4 pt-3`} role="status">
          正在读取文件
        </p>
      )}
    </>
  );
}

function Result({ settled }: { settled: Settled }) {
  if ("message" in settled) {
    return <Failure message={settled.message} />;
  }

  const { entries, truncated } = settled.listing;
  if (entries.length === 0) {
    return <p className="px-4 pt-3 text-[13px] text-muted-foreground">压缩包内没有文件</p>;
  }
  // 成员名可以重复、可以是空串，不能当 key：按位置编号。
  const rows = entries.map((entry, position) => ({ entry, position }));
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 pt-3 pb-5" data-slot="preview-archive">
      <p className="mb-[0.65rem] text-[0.75rem] text-(--wb-text-tertiary)">
        {truncated ? `仅显示前 ${entries.length} 项` : `共 ${entries.length} 项`}
      </p>
      <table aria-label="压缩包成员" className="w-full table-fixed border-collapse text-[0.8rem]">
        <tbody>
          {rows.map(({ entry, position }) => (
            <tr className="border-b border-(--wb-border-default)" key={position}>
              <td className="truncate py-[0.35rem] pr-3" title={entry.path}>
                {entry.type === "dir" ? (
                  <span className="mr-1.5 inline-flex align-middle text-(--wb-text-secondary)">
                    <Icon name="folder" size={14} />
                  </span>
                ) : null}
                {entry.path}
              </td>
              <td className="w-24 py-[0.35rem] text-right whitespace-nowrap text-(--wb-text-tertiary)">
                {sizeText(entry)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
