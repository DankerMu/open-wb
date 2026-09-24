import * as ToastPrimitive from "@radix-ui/react-toast";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./icon.js";

type ToastType = "success" | "error" | "info";
type ToastRecord = { id: number; type: ToastType; message: string };
type ToastApi = { show(input: { type: ToastType; message: string }): void };

/** 同时最多显示的条数；超出丢最旧。 */
const MAX_TOASTS = 3;
/** Radix Provider 的自动关闭时长（hover/focus 期间由 Radix 暂停）。 */
const TOAST_DURATION_MS = 2400;
const ICONS = { success: "circle-check", error: "triangle-alert", info: "info" } as const;

const ToastContext = createContext<ToastApi | null>(null);

/**
 * 应用根的通知出口：本组件只持有队列（追加、上限 3 丢最旧、关闭即移除）；计时与 hover/focus
 * 暂停恢复、Escape/滑动关闭、`type="background"` 的 polite 播报区、Viewport region 与 F8 热键
 * 全部由 Radix Toast 提供，本文件不写定时器。样式映射 demo `.toast-stack`/`.toast`（toast.css）。
 * `epoch`：Radix 1.2.23 的暂停标记留在其 Provider 上、只由有 toast 时的 Viewport 监听清除，
 * 暂停中关掉最后一条会让它永远为 true；队列非空→空时 epoch +1，以 `key` 重挂 Radix Provider
 * 归零（`children` 在其外，应用树不随之重挂）。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ toasts: ToastRecord[]; epoch: number }>({
    toasts: [],
    epoch: 0,
  });
  const nextId = useRef(0);
  const show = useCallback(({ type, message }: { type: ToastType; message: string }) => {
    setState((prev) => ({
      ...prev,
      toasts: [...prev.toasts, { id: nextId.current++, type, message }].slice(-MAX_TOASTS),
    }));
  }, []);
  const dismiss = useCallback((id: number) => {
    setState((prev) => {
      const toasts = prev.toasts.filter((toast) => toast.id !== id);
      const emptied = toasts.length === 0 && prev.toasts.length > 0;
      return { toasts, epoch: emptied ? prev.epoch + 1 : prev.epoch };
    });
  }, []);
  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastPrimitive.Provider duration={TOAST_DURATION_MS} key={state.epoch} label="通知">
        {state.toasts.map((toast) => (
          <ToastPrimitive.Root
            className={`ui-toast ui-toast--${toast.type}`}
            key={toast.id}
            onOpenChange={(open) => {
              if (!open) dismiss(toast.id);
            }}
            open
            type="background"
          >
            <Icon name={ICONS[toast.type]} size={16} />
            <ToastPrimitive.Description className="ui-toast-message">
              {toast.message}
            </ToastPrimitive.Description>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="ui-toast-viewport" label="通知" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

/** feature 触发通知的唯一入口；须在 `ToastProvider` 内调用。 */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast 须在 ToastProvider 内使用");
  return context;
}
