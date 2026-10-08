// 会话页对列表事件连接的消费（session-list-push「web 列表事件消费」）：单飞的列表重取、重连补读与
// 另一个标签页撤回后的重读。无渲染 hook，只由 `useChatSession` 接线。
import { useCallback, useEffect, useRef } from "react";
import type { ApiClient } from "../../lib/api.js";
import { connectSessionListEvents } from "../../lib/session-list-events.js";

type ListEventsPage = {
  /** 当前账号的 client；它换了就关掉旧连接、另开一条。 */
  client: ApiClient;
  /**
   * 发起一次列表读取（连同并行的工作空间读取），顶替在途的那一次。返回的 promise 在这次读取有了
   * 结果、失败或被中止之后兑现，从不拒绝；没有发起（client 已不是当前的）时返回 null。
   * `silent` 为真时失败不改页面状态：现有列表与分组留着，不出错误文案。
   */
  readList(client: ApiClient, silent: boolean): Promise<void> | null;
  /**
   * 选中且历史已加载的会话：`running` 是它在页面视图里的状态，`resync` 经它的单会话事件流重读消息
   * 快照并整体替换视图。没有选中会话、或它的历史还没加载完时为 null。
   */
  selected(): { sessionId: string; running: boolean; resync(): void } | null;
  /** 本页此刻有针对所选会话的在途撤回请求：它自己会对齐视图，列表事件不再重读。只在本来要重读时调用。 */
  undoInFlight(): boolean;
};

/**
 * 持有恰一条列表事件连接，卸载与换账号时关闭。返回页面动作用的 `refreshList`。
 *
 * 列表读取只有一个在途槽位，页面动作与通知共用：
 * - 通知（每次 `open`、每条 `sessions.changed`）到达时槽位空着就发一次静默读取；槽位被占着——不论
 *   占着的是通知读取还是页面动作的读取——只记「还要再读一次」。
 * - 页面动作的 `refreshList` 语义不变：中止在途的读取并重发，失败置错误。它接管槽位，「还要再读
 *   一次」留着；被它顶替的那次读取随后落定时什么也不做（不补读，也不会反过来中止动作的读取）。
 * - 占着槽位的读取落定后，若记着「还要再读一次」，恰补一次静默读取。最后一次读取因此总是开始于
 *   最后一条通知之后。
 *
 * 连接出错、或运行环境没有 `EventSource` 时这里什么也不显示：`refreshList` 照常可用。
 */
export function useSessionListEvents(page: ListEventsPage) {
  const { client } = page;
  const pageRef = useRef(page);
  pageRef.current = page;
  const flightRef = useRef<Promise<void> | null>(null);
  const againRef = useRef(false);

  const read = useCallback((ownedClient: ApiClient, silent: boolean) => {
    const flight = pageRef.current.readList(ownedClient, silent);
    if (flight === null) {
      return;
    }
    flightRef.current = flight;
    void flight.then(() => {
      if (flightRef.current !== flight) {
        return;
      }
      flightRef.current = null;
      if (againRef.current) {
        againRef.current = false;
        read(ownedClient, true);
      }
    });
  }, []);

  const refreshList = useCallback(
    (ownedClient: ApiClient) => {
      read(ownedClient, false);
    },
    [read],
  );

  useEffect(() => {
    const notify = () => {
      if (flightRef.current === null) {
        read(client, true);
      } else {
        againRef.current = true;
      }
    };
    const resyncSelected = (sessionId: string | null, evenRunning: boolean) => {
      const selected = pageRef.current.selected();
      if (
        selected === null ||
        (sessionId !== null && selected.sessionId !== sessionId) ||
        (selected.running && !evenRunning) ||
        pageRef.current.undoInFlight()
      ) {
        return;
      }
      selected.resync();
    };
    const connection = connectSessionListEvents({
      onOpen({ reopened }) {
        notify();
        // 断开期间的 `session.rewound` 不回放；`running` 的会话由它自己的事件流对齐。
        if (reopened) {
          resyncSelected(null, false);
        }
      },
      onChanged: notify,
      onRewound(sessionId) {
        resyncSelected(sessionId, true);
      },
    });
    return () => {
      connection.close();
      // 欠账属于这条连接：换账号后不拿它去读新账号的列表。
      againRef.current = false;
    };
  }, [client, read]);

  return refreshList;
}
