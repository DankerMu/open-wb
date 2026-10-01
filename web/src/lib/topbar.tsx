import {
  createContext,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { IconName } from "../ui/index.js";

/**
 * 页面注入顶栏的按钮描述符（不是 React 节点，可比较）：`key` 在数组内唯一（调用方契约，不校验）；
 * `label` 同时是 accessible name 与 Tooltip；提供 `expanded` 时按钮带同值 `aria-expanded`；
 * 点击时以该按钮元素为 `trigger` 调用 `onSelect`，供页面把焦点归还给触发按钮。
 */
export type TopbarAction = {
  key: string;
  label: string;
  icon: IconName;
  expanded?: boolean;
  onSelect(trigger: HTMLElement): void;
};

type TopbarContextValue = {
  breadcrumb: string | null;
  setBreadcrumb: (next: string | null) => void;
  actions: readonly TopbarAction[];
  setActions: Dispatch<SetStateAction<readonly TopbarAction[]>>;
  /** 上报方最近一次渲染的描述符：state 因浅比较不更新时，`onSelect` 仍从这里取最新闭包。 */
  latestActions: RefObject<readonly TopbarAction[]>;
};

const TopbarContext = createContext<TopbarContextValue | null>(null);

const NO_ACTIONS: readonly TopbarAction[] = [];

/** 可比较字段逐项相同（`expanded` 缺省与 `undefined` 等价）；`onSelect` 不参与比较。 */
function sameActions(prev: readonly TopbarAction[], next: readonly TopbarAction[]): boolean {
  return (
    prev.length === next.length &&
    prev.every((item, index) => {
      const other = next[index];
      return (
        other !== undefined &&
        item.key === other.key &&
        item.label === other.label &&
        item.icon === other.icon &&
        item.expanded === other.expanded
      );
    })
  );
}

/**
 * shell 持有的顶栏状态：页面经 `useTopbar` 上报，`Topbar` 经 `useTopbarBreadcrumb` 与
 * `useTopbarActions` 读取。
 */
export function TopbarProvider({ children }: { children: ReactNode }) {
  const [breadcrumb, setBreadcrumb] = useState<string | null>(null);
  const [actions, setActions] = useState<readonly TopbarAction[]>(NO_ACTIONS);
  const latestActions = useRef<readonly TopbarAction[]>(NO_ACTIONS);
  const value = useMemo(
    () => ({ breadcrumb, setBreadcrumb, actions, setActions, latestActions }),
    [breadcrumb, actions],
  );
  return <TopbarContext.Provider value={value}>{children}</TopbarContext.Provider>;
}

/**
 * 页面向 shell 上报面包屑与 actions；Provider 外 no-op。变更即更新，卸载时清空；面包屑改为
 * undefined 时清空，未提供 `actions` 与空数组都上报为空。
 * 用 layout effect 在绘制前同步，导航后不会闪出一帧陈旧面包屑、陈旧按钮或双 h1。
 */
export function useTopbar({
  breadcrumb,
  actions,
}: {
  breadcrumb?: string | undefined;
  actions?: readonly TopbarAction[] | undefined;
}): void {
  const context = useContext(TopbarContext);
  const set = context?.setBreadcrumb;
  useLayoutEffect(() => {
    if (!set || breadcrumb === undefined) return;
    set(breadcrumb);
    return () => set(null);
  }, [set, breadcrumb]);
  const setActions = context?.setActions;
  const latestActions = context?.latestActions;
  // `actions` 每次渲染都是新数组：本 effect 无依赖、无 cleanup，每次渲染先记下最新的 onSelect，
  // 再只在可比较字段有变化时换 state——带 cleanup 会每次先清空再上报，state 必变而成环。
  useLayoutEffect(() => {
    if (!setActions || !latestActions) return;
    const next = actions ?? NO_ACTIONS;
    latestActions.current = next;
    setActions((prev) => (sameActions(prev, next) ? prev : next));
  });
  useLayoutEffect(() => {
    if (!setActions) return;
    return () => setActions(NO_ACTIONS);
  }, [setActions]);
}

export function useTopbarBreadcrumb(): string | null {
  return useContext(TopbarContext)?.breadcrumb ?? null;
}

/**
 * shell 读取 actions；Provider 外为空数组。数组与各项 `onSelect` 包装随 state 派生：可比较字段
 * 不变则引用不变，包装在调用时按 `key` 取上报方最近一次渲染的回调。
 */
export function useTopbarActions(): readonly TopbarAction[] {
  const context = useContext(TopbarContext);
  const actions = context?.actions ?? NO_ACTIONS;
  const latestActions = context?.latestActions;
  return useMemo(
    () =>
      actions.map((action) => ({
        ...action,
        onSelect: (trigger: HTMLElement) =>
          latestActions?.current.find((item) => item.key === action.key)?.onSelect(trigger),
      })),
    [actions, latestActions],
  );
}
