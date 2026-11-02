import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ApiClient, ApiError, REQUEST_FAILED_MESSAGE } from "@/lib/api";
import type { IngestOutcome } from "./ingest-dialog.js";

/** 同 `upload_too_large` 的信封文案与「工作空间来源入库」`too_large` 的 `message`。 */
const TOO_LARGE = "文件超过大小上限";

type Failure = IngestOutcome["failures"][number];

/**
 * 逐个上传：前一个应答之后才发下一个；失败交给 `onFailure` 后继续。`signal` 中止后不再发，也不再报告。返回是否至少
 * 一个成功。
 */
async function uploadInTurn(
  client: ApiClient,
  baseId: string,
  files: readonly File[],
  signal: AbortSignal,
  onFailure: (failure: Failure) => void,
): Promise<boolean> {
  let uploaded = false;
  for (const item of files) {
    if (signal.aborted) break;
    try {
      await client.uploadToKnowledgeBase(baseId, item, { signal });
      uploaded = true;
    } catch (error) {
      if (signal.aborted) break;
      onFailure({
        name: item.name,
        message: error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE,
      });
    }
  }
  return uploaded;
}

type UploadButtonProps = {
  client: ApiClient;
  baseId: string;
  /** `GET /api/kb/status` 的 `uploadMaxFiles` 与 `uploadMaxBytes`。 */
  maxFiles: number;
  maxBytes: number;
  /** 每次结果变化时给出这一批到目前为止的结果（共用的入库结果显示）。 */
  onOutcome(outcome: IngestOutcome): void;
  /** 这一批至少一个文件上传成功：调用方重取一次文档列表。 */
  onUploaded(): void;
};

/**
 * `上传文件`（knowledge-bases「中心「知识库」tab」，design D11，s2a-kb-ragflow 16.5）：选择文件后，多于 `maxFiles` 个
 * 整批就地拒绝（同 S1g 附件的整批拒绝），单个超过 `maxBytes` 的就地拒绝；其余逐个调用 `uploadToKnowledgeBase`，前一个
 * 应答后才发下一个，失败（含 400 `kb_file_unsupported`）记下该文件的信封文案后继续。后缀不在客户端判定，由服务端按
 * 模板判。上传中按钮禁用；卸载（换库）即中止在途的请求，不再发后面的。
 */
export function UploadButton({
  client,
  baseId,
  maxFiles,
  maxBytes,
  onOutcome,
  onUploaded,
}: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const live = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    live.current = controller;
    return () => controller.abort();
  }, []);

  async function upload(files: File[]) {
    if (files.length === 0 || running.current) return;
    if (files.length > maxFiles) {
      onOutcome({ notice: `一次最多上传 ${maxFiles} 个文件`, failures: [] });
      return;
    }
    const { signal } = live.current;
    const failures = files
      .filter((item) => item.size > maxBytes)
      .map((item) => ({ name: item.name, message: TOO_LARGE }));
    onOutcome({ notice: null, failures: [...failures] });
    running.current = true;
    setBusy(true);
    const accepted = files.filter((item) => item.size <= maxBytes);
    const uploaded = await uploadInTurn(client, baseId, accepted, signal, (failure) => {
      failures.push(failure);
      onOutcome({ notice: null, failures: [...failures] });
    });
    if (signal.aborted) return;
    running.current = false;
    setBusy(false);
    if (uploaded) onUploaded();
  }

  return (
    <>
      <Button
        aria-busy={busy ? true : undefined}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        size="sm"
        variant="outline"
      >
        上传文件
      </Button>
      <input
        hidden
        multiple
        onChange={(event) => {
          void upload(Array.from(event.target.files ?? []));
          // 清掉选择：同一个文件可以再选一次。
          event.target.value = "";
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
    </>
  );
}
