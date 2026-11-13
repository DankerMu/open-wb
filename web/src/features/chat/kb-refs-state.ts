// 输入框知识库引用的页面状态（无渲染 hook）与纯函数（message-attachments「输入框知识库引用」）：再选即取消、按加入
// 次序、上限 5；状态只在页面内存，属于一个草稿归属（已选会话 id，欢迎态为 null）与一个 client。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, BaseView } from "../../lib/api.js";

/** 一个引用：库 id 与选中时的库名（标签不依赖选择列表的那次读取）。 */
export type KbRef = Pick<BaseView, "id" | "name">;

export const KB_REF_LIMIT = 5;

/** 未引用的加到末尾（已满时原样返回），已引用的去掉。 */
export function toggleKbRef(refs: readonly KbRef[], ref: KbRef): readonly KbRef[] {
  if (refs.some((item) => item.id === ref.id)) return removeKbRef(refs, ref.id);
  return refs.length >= KB_REF_LIMIT ? refs : [...refs, { id: ref.id, name: ref.name }];
}

export function removeKbRef(refs: readonly KbRef[], id: string): readonly KbRef[] {
  return refs.some((item) => item.id === id) ? refs.filter((item) => item.id !== id) : refs;
}

type KbRefsState = { client: ApiClient; owner: string | null; refs: readonly KbRef[] };

const NONE: readonly KbRef[] = [];

/**
 * 引用按归属存放：渲染所在归属（`scopeKey`）与 `owner` 不同就不给出；真正清空只在 `client` 或 `scopeKey` 变化后的
 * effect 里（切换会话、回到欢迎态、换账号）。`adopt` 先写 ref：欢迎态建出会话后 `navigate(…, { flushSync })` 可能先
 * 渲染出「已选新 id、`owner` 还是欢迎态」的一帧，那一帧只是不显示，effect 读 ref 认得这是交接，不清空。
 * `ids` / `clear` 按归属读写（`ids` 随 `client` 换新，其余引用稳定），给回合派发用：发送时读、受理后清，未受理不动。
 */
export function useKbRefsState(client: ApiClient, scopeKey: string | null) {
  const [state, setState] = useState<KbRefsState>({ client, owner: scopeKey, refs: NONE });
  const stateRef = useRef(state);
  // 欢迎态的引用刚交给的会话（`adopt` 写入）：选中它的那次渲染之前，欢迎态照常给出这些引用。
  const heirRef = useRef<string | null>(null);

  const commit = useCallback((next: KbRefsState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    heirRef.current = null;
    const current = stateRef.current;
    if (current.client !== client || current.owner !== scopeKey) {
      commit({ client, owner: scopeKey, refs: NONE });
    }
  }, [client, commit, scopeKey]);

  /** 改写当前归属的引用；`owner` 不是当前草稿（交接之后、选中之前）时照样改它。 */
  const update = useCallback(
    (change: (refs: readonly KbRef[]) => readonly KbRef[]) => {
      const current = stateRef.current;
      commit({ ...current, refs: change(current.refs) });
    },
    [commit],
  );
  const toggle = useCallback((ref: KbRef) => update((refs) => toggleKbRef(refs, ref)), [update]);
  const remove = useCallback((id: string) => update((refs) => removeKbRef(refs, id)), [update]);

  const adopt = useCallback(
    (sessionId: string) => {
      const current = stateRef.current;
      if (current.owner === null && current.refs.length > 0) {
        heirRef.current = sessionId;
        commit({ ...current, owner: sessionId });
      }
    },
    [commit],
  );
  // 与渲染同一判据：属于别的 client（换账号后、清空的 effect 之前）的引用不发出。
  const ids = useCallback(
    (owner: string) => {
      const current = stateRef.current;
      return current.client === client && current.owner === owner
        ? current.refs.map(({ id }) => id)
        : [];
    },
    [client],
  );
  const clear = useCallback(
    (owner: string) => {
      const current = stateRef.current;
      if (current.owner === owner && current.refs.length > 0) commit({ ...current, refs: NONE });
    },
    [commit],
  );

  const shownKey = scopeKey ?? heirRef.current;
  const refs = state.client === client && state.owner === shownKey ? state.refs : NONE;
  return useMemo(
    () => ({ adopt, clear, ids, refs, remove, toggle }),
    [adopt, clear, ids, refs, remove, toggle],
  );
}
