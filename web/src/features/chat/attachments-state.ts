// 输入框附件的页面状态（无渲染 hook）：标签列表、统一的接收入口、串行上传队列、移除、清空与恢复。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { ComposerOptions } from "../../lib/composer-contract.js";
import type { ChatSessionFork } from "../../lib/session-contract.js";
import { errorMessage } from "./errors.js";

type UploadClient = Pick<ApiClient, "uploadFile">;

/** 一个附件标签。排队中也是 `uploading`（`percent` 为 0）；`pending` 只出现在欢迎态。 */
type Attachment = {
  id: number;
  scopeKey: string | null;
  name: string;
  size: number;
  status: "pending" | "uploading" | "uploaded" | "failed";
  percent: number;
  path: string | null;
  message: string | null;
};

/** 标签连同它的归属（账号与会话）和待传的文件；`workspaceId` 是接收那一刻的上传目标。 */
type Entry = {
  client: UploadClient;
  file: File | null;
  workspaceId: string | null;
  item: Attachment;
};

type AttachmentsScope = {
  client: UploadClient;
  /** 当前会话 id，欢迎态为 null。 */
  scopeKey: string | null;
  /** 输入框所在的工作空间：没有为 null，会话尚未解析出来为 undefined。 */
  workspaceId: string | null | undefined;
  /** `options.upload`；选项未取得时为 null 或 undefined（调用处直接写 `options?.upload`）。 */
  upload: ComposerOptions["upload"] | null | undefined;
};

export const NO_WORKSPACE = "此会话没有工作空间，无法上传文件";

function owns(entry: Entry, client: UploadClient, scopeKey: string | null) {
  return entry.client === client && entry.item.scopeKey === scopeKey;
}

/**
 * 标签按归属（账号 + 会话）存放，只给出归属于当前会话的：fork 先恢复标签、后选中新会话，「会话一变
 * 就全清」会抹掉刚恢复的。会话或账号变化时丢弃归属不符的记录，卸载时全部丢弃；被丢弃的在途请求中止，
 * 排队的不再发出。
 *
 * 同一时刻至多一个上传在途。中止的拒绝与网络失败是同一个错误，无法区分，所以结果与进度一律按 `id`
 * 写回存活的记录，找不到就丢弃；在途闩只由当前在途的那个请求释放。
 */
export function useAttachmentsState(scope: AttachmentsScope) {
  const { client, scopeKey } = scope;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const entriesRef = useRef(entries);
  const scopeRef = useRef(scope);
  const flightRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const nextIdRef = useRef(1);

  scopeRef.current = scope;

  const commit = useCallback((next: Entry[]) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const patch = useCallback(
    (id: number, change: Partial<Attachment>) => {
      const current = entriesRef.current;
      if (current.some((entry) => entry.item.id === id)) {
        commit(
          current.map((entry) =>
            entry.item.id === id ? { ...entry, item: { ...entry.item, ...change } } : entry,
          ),
        );
      }
    },
    [commit],
  );

  // 发出队首（当前会话里最早的 `uploading` 记录）；已有在途的就不动。
  const pump = useCallback(
    function advance() {
      if (flightRef.current) {
        return;
      }
      const current = scopeRef.current;
      const next = entriesRef.current.find(
        (entry) =>
          owns(entry, current.client, current.scopeKey) && entry.item.status === "uploading",
      );
      if (!next?.file || next.workspaceId === null) {
        return;
      }
      const { id } = next.item;
      const controller = new AbortController();
      flightRef.current = { id, controller };
      void next.client
        .uploadFile(next.workspaceId, next.file, {
          signal: controller.signal,
          onProgress: (percent) => patch(id, { percent }),
        })
        .then(
          ({ name, path, size }) =>
            patch(id, { status: "uploaded", percent: 100, name, path, size }),
          (error: unknown) => patch(id, { status: "failed", message: errorMessage(error) }),
        )
        .then(() => {
          if (flightRef.current?.controller === controller) {
            flightRef.current = null;
            advance();
          }
        });
    },
    [patch],
  );

  // 只留下 `keep` 的记录：在途的那个若被丢弃就中止并释放闩，然后推进队列。
  const retain = useCallback(
    (keep: (entry: Entry) => boolean) => {
      const next = entriesRef.current.filter(keep);
      const flight = flightRef.current;
      if (flight && !next.some((entry) => entry.item.id === flight.id)) {
        flightRef.current = null;
        flight.controller.abort();
      }
      if (next.length !== entriesRef.current.length) {
        commit(next);
      }
      pump();
    },
    [commit, pump],
  );

  useEffect(() => {
    retain((entry) => owns(entry, client, scopeKey));
    setNotice(null);
  }, [client, retain, scopeKey]);

  useEffect(() => () => retain(() => false), [retain]);

  const accept = useCallback(
    (files: File[]) => {
      const current = scopeRef.current;
      const { upload, workspaceId } = current;
      if (!upload || workspaceId === undefined) {
        return;
      }
      if (current.scopeKey !== null && workspaceId === null) {
        setNotice(NO_WORKSPACE);
        return;
      }
      const held = entriesRef.current.filter((entry) =>
        owns(entry, current.client, current.scopeKey),
      ).length;
      if (held + files.length > upload.maxFiles) {
        setNotice(`每条消息最多 ${upload.maxFiles} 个附件`);
        return;
      }
      const oversize = files.find((file) => file.size > upload.maxBytes);
      setNotice(oversize ? `「${oversize.name}」超过大小上限` : null);
      const added = files
        .filter((file) => file.size <= upload.maxBytes)
        .map((file): Entry => {
          const id = nextIdRef.current;
          nextIdRef.current += 1;
          return {
            client: current.client,
            file,
            workspaceId,
            item: {
              id,
              scopeKey: current.scopeKey,
              name: file.name,
              size: file.size,
              status: current.scopeKey === null ? "pending" : "uploading",
              percent: 0,
              path: null,
              message: null,
            },
          };
        });
      commit([...entriesRef.current, ...added]);
      pump();
    },
    [commit, pump],
  );

  const remove = useCallback(
    (id: number) => {
      retain((entry) => entry.item.id !== id);
    },
    [retain],
  );

  // 把 `key` 的标签整个换成 `items`（不发请求），返回被换掉的；`key` 不必是当前会话。发送时取走、
  // 未受理时原样放回，fork / undo 的恢复也走这里。
  const replace = useCallback(
    (key: string, items: Attachment[]) => {
      const owner = scopeRef.current.client;
      const replaced = entriesRef.current
        .filter((entry) => owns(entry, owner, key))
        .map((entry) => entry.item);
      retain((entry) => !owns(entry, owner, key));
      const written = items.map(
        (item): Entry => ({
          client: owner,
          file: null,
          workspaceId: null,
          item: { ...item, scopeKey: key },
        }),
      );
      commit([...entriesRef.current, ...written]);
      setNotice(null);
      return replaced;
    },
    [commit, retain],
  );

  // 覆盖 `key` 的既有标签；fork 在选中新会话之前恢复。
  const restore = useCallback(
    (key: string, attachments: ChatSessionFork["attachments"]) => {
      replace(
        key,
        attachments.map(({ path, size }) => {
          const id = nextIdRef.current;
          nextIdRef.current += 1;
          return {
            id,
            scopeKey: key,
            name: path.slice(path.lastIndexOf("/") + 1),
            size,
            status: "uploaded",
            percent: 100,
            path,
            message: null,
          };
        }),
      );
    },
    [replace],
  );

  const items = useMemo(
    () => entries.filter((entry) => owns(entry, client, scopeKey)).map((entry) => entry.item),
    [client, entries, scopeKey],
  );

  return { items, notice, accept, remove, replace, restore };
}
