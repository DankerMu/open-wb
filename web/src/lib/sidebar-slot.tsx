import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useLayoutEffect,
  useState,
} from "react";

type SlotSetter = Dispatch<SetStateAction<ReactNode | null>>;

// setter 与 value 分成两个 context：上报方只订阅稳定的 setter，节点每次渲染都变也不会回环。
const SlotSetterContext = createContext<SlotSetter | null>(null);
const SlotValueContext = createContext<ReactNode | null>(null);
const SidebarNavigateContext = createContext<(() => void) | undefined>(undefined);

/**
 * shell 持有的侧栏列表区槽位：页面经 `useSidebarSlot` 上报已渲染的节点，`Sidebar` 在自己的
 * React 树内渲染它（Radix Drawer 按 React 树判定内外，portal 进去会被当成外部点击）。
 * state 放在本组件里、children 由调用方稳定传入，上报只重渲染读 value 的列表区。
 */
export function SidebarSlotProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode | null>(null);
  return (
    <SlotSetterContext.Provider value={setNode}>
      <SlotValueContext.Provider value={node}>{children}</SlotValueContext.Provider>
    </SlotSetterContext.Provider>
  );
}

/**
 * 页面向侧栏上报列表节点；Provider 外 no-op。layout effect 在绘制前同步，列表不闪；
 * 卸载时清空，离开路由后侧栏不残留旧列表。
 */
export function useSidebarSlot(node: ReactNode): void {
  const set = useContext(SlotSetterContext);
  useLayoutEffect(() => {
    set?.(node);
  }, [set, node]);
  useLayoutEffect(() => {
    if (!set) return;
    return () => set(null);
  }, [set]);
}

export function useSidebarSlotContent(): ReactNode | null {
  return useContext(SlotValueContext);
}

/** 覆盖层变体在列表节点外提供关闭回调；文档流侧栏与 Provider 外均为 undefined。 */
export function SidebarNavigateProvider({
  children,
  onNavigate,
}: {
  children: ReactNode;
  onNavigate: (() => void) | undefined;
}) {
  return (
    <SidebarNavigateContext.Provider value={onNavigate}>{children}</SidebarNavigateContext.Provider>
  );
}

export function useSidebarNavigate(): (() => void) | undefined {
  return useContext(SidebarNavigateContext);
}
