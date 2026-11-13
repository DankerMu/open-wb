// 知识库状态的共用读取与状态字样：中心页（tab 显隐、知识库列表）与会话页（「+」菜单的引用入口、引用选择列表）共用。
import { useEffect, useState } from "react";
import type { ApiClient, BaseView } from "./api.js";

/** 每个 client 读一次 `GET /api/kb/status`：在途为 `null`，读取失败视为未开启。 */
export function useKbEnabled(client: ApiClient): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    client.getKbStatus().then(
      (status) => {
        if (live) setEnabled(status.enabled);
      },
      () => {
        if (live) setEnabled(false);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);
  return enabled;
}

/** 知识库状态字样（按 `BaseView.state`）：`ready` 不写字。 */
export const STATE_MARK: Readonly<Record<BaseView["state"], string | null>> = {
  ready: null,
  rebuilding: "重建中",
  rebuild_failed: "重建失败",
};
