import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ApiClient, KbIngestResult } from "@/lib/api";
import { useEscapeFallback } from "../../../components/escape-fallback.js";
import { ALERT, MUTED, messageOf, WorkspaceFiles } from "./ingest-tree.js";
import type { WorkspacesView } from "./use-documents.js";

/** 一次入库或上传的结果：整批拒绝的提示，与逐条未入库的文件及其文案。 */
export type IngestOutcome = {
  notice: string | null;
  failures: { name: string; message: string }[];
};

/**
 * 入库结果（两个入口共用，s2a-kb-ragflow 16.5）：`从工作空间入库` 被拒的条目与 `上传文件` 的就地拒绝、失败，逐条为
 * `<路径或文件名>：<文案>`。一批里的路径（文件名）互不相同，用作 key。没有可显示的内容时不渲染。
 */
export function IngestResults({ outcome }: { outcome: IngestOutcome | null }) {
  if (!outcome || (outcome.notice === null && outcome.failures.length === 0)) return null;
  return (
    <div className="ui-alert flex flex-col gap-1" role="alert">
      {outcome.notice}
      {outcome.failures.length > 0 ? (
        // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
        <ul className="m-0 list-none p-0" role="list">
          {outcome.failures.map((item) => (
            <li className="[overflow-wrap:anywhere]" key={item.name}>
              {`${item.name}：${item.message}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 没有可选的工作空间时的说明：读取中、失败（信封文案与 `重试`）或确实没有。 */
function WorkspacesNote({ workspaces, onRetry }: { workspaces: WorkspacesView; onRetry(): void }) {
  if (workspaces.status === "loading") return <p className={MUTED}>正在读取工作空间</p>;
  if (workspaces.status === "ready") return <p className={MUTED}>没有可用的工作空间</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className={ALERT} role="alert">
        {workspaces.message}
      </p>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        重试
      </Button>
    </div>
  );
}

type IngestDialogProps = {
  client: ApiClient;
  baseId: string;
  /** 当前用户的工作空间（`use-documents.ts` 读的那一次），按列表次序；缺省选第一个。 */
  workspaces: WorkspacesView;
  /** 工作空间读取失败时的 `重试`：重读 `listWorkspaces`。 */
  onRetryWorkspaces(): void;
  /** `GET /api/kb/status` 的 `uploadMaxFiles`。 */
  maxFiles: number;
  restoreFocus(): void;
  /** 201：调用方关闭对话框、显示被拒的条目并重取一次文档列表。 */
  onDone(result: KbIngestResult): void;
  onCancel(): void;
};

/**
 * `从工作空间入库` 对话框（knowledge-bases「中心「知识库」tab」，s2a-kb-ragflow 16.5）：选工作空间，逐级浏览目录并勾选
 * 文件，至多 `maxFiles` 个；提交恰调用一次 `ingestFromWorkspace`。请求在途时两个按钮禁用，Escape、遮罩与关闭按钮
 * 也关不掉；整个请求失败时信封文案以 `role="alert"` 留在框内。换空间清掉勾选。
 */
export function IngestDialog({
  client,
  baseId,
  workspaces: spaces,
  onRetryWorkspaces,
  maxFiles,
  restoreFocus,
  onDone,
  onCancel,
}: IngestDialogProps) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 在途标记：同一帧里的第二次提交还看不到 `pending` 的重渲染，靠它拦下。 */
  const sending = useRef(false);
  const spaceId = useId();
  const workspaces = spaces.status === "ready" ? spaces.workspaces : [];
  const workspace = workspaces.find((item) => item.id === chosen) ?? workspaces[0];
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || checked.length === 0 || sending.current) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      onDone(
        await client.ingestFromWorkspace(baseId, { workspaceId: workspace.id, paths: checked }),
      );
    } catch (failure) {
      setError(messageOf(failure));
      setPending(false);
    } finally {
      sending.current = false;
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">从工作空间入库</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void submit(event)}>
          {workspace ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={spaceId}>工作空间</Label>
                <Select
                  disabled={pending}
                  onValueChange={(id) => {
                    setChosen(id);
                    setChecked([]);
                  }}
                  value={workspace.id}
                >
                  <SelectTrigger className="w-full" id={spaceId}>
                    <SelectValue>{workspace.name}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-md border p-1.5">
                <WorkspaceFiles
                  checked={checked}
                  client={client}
                  full={checked.length >= maxFiles}
                  key={workspace.id}
                  onToggle={(path, on) =>
                    setChecked((current) =>
                      on
                        ? current.includes(path)
                          ? current
                          : [...current, path]
                        : current.filter((p) => p !== path),
                    )
                  }
                  workspaceId={workspace.id}
                />
              </div>
              <p className={MUTED}>{`已选 ${checked.length} / ${maxFiles}`}</p>
            </>
          ) : (
            <WorkspacesNote onRetry={onRetryWorkspaces} workspaces={spaces} />
          )}
          {error ? (
            <p className={`${ALERT} rounded-lg bg-destructive/10 px-2.5 py-2`} role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={pending} onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
            <Button
              aria-busy={pending ? true : undefined}
              disabled={pending || checked.length === 0}
              type="submit"
            >
              入库并解析
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
