import * as DialogPrimitive from "@radix-ui/react-dialog";
import { type ReactElement, type ReactNode, type RefObject, useRef } from "react";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

type FocusTarget = RefObject<HTMLElement | null>;

/**
 * 焦点交接（Dialog/ConfirmDialog/Drawer 共用）：打开者在 `onOpenAutoFocus` 里记录——FocusScope 先派发
 * 该事件、再移动焦点，此刻活动元素必是打开者（不能用 effect：子组件 effect 先于父组件跑）。
 * Radix 模态 Content 关闭时只把焦点还给 `Dialog.Trigger`，无 trigger 时落到 body；故「传了
 * `returnFocus`」或「无 trigger」时由本组件拦截并归还 `returnFocus ?? 打开者`，否则交给 Radix。
 *
 * 调用方指定初始焦点只能走 `initialFocus`，禁止在内容里用 React `autoFocus`：挂载时焦点若已在容器内，
 * FocusScope 不派发 `onMountAutoFocus`（即不触发 `onOpenAutoFocus`），打开者记录不会更新而停留在
 * 上一次打开时的旧值，关闭后焦点会被归还到错误元素。
 */
export function useFocusHandoff({
  initialFocus,
  returnFocus,
  hasTrigger = false,
}: {
  initialFocus?: FocusTarget | undefined;
  returnFocus?: FocusTarget | undefined;
  hasTrigger?: boolean;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      opener.current = document.activeElement as HTMLElement | null;
      if (initialFocus) {
        event.preventDefault();
        initialFocus.current?.focus();
      }
    },
    onCloseAutoFocus(event: Event) {
      if (returnFocus || !hasTrigger) {
        event.preventDefault();
        (returnFocus?.current ?? opener.current)?.focus();
      }
    },
  };
}

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  size?: "sm" | "md" | undefined;
  /**
   * 打开时改聚焦该元素（默认聚焦内容内首个可聚焦控件）。必须用它而非 React `autoFocus`：焦点已在
   * 容器内时 FocusScope 不派发 `onMountAutoFocus`，打开者记录会过期，关闭后焦点归还错位。
   */
  initialFocus?: FocusTarget | undefined;
  /** 关闭后焦点归还目标；未传且无 `trigger` 时归还打开瞬间的活动元素，有 `trigger` 时由 Radix 归还 trigger。 */
  returnFocus?: FocusTarget | undefined;
  /** false 时 Escape/遮罩点击不关闭，且不渲染右上 `关闭` 按钮。 */
  dismissible?: boolean | undefined;
  footer?: ReactNode;
  trigger?: ReactElement | undefined;
  children?: ReactNode;
};

type DialogFrameProps = Omit<DialogProps, "dismissible" | "size"> & {
  size: "sm" | "md";
  role: "dialog" | "alertdialog";
  showClose: boolean;
  closeOnEscape: boolean;
  closeOnOverlay: boolean;
};

/** Dialog 与 ConfirmDialog 的共用骨架（不经 index 导出）；关闭策略由调用方逐项给定。 */
export function DialogFrame({
  open,
  onOpenChange,
  title,
  description,
  size,
  initialFocus,
  returnFocus,
  footer,
  trigger,
  children,
  role,
  showClose,
  closeOnEscape,
  closeOnOverlay,
}: DialogFrameProps) {
  const focus = useFocusHandoff({ initialFocus, returnFocus, hasTrigger: Boolean(trigger) });
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-dialog-overlay">
          <DialogPrimitive.Content
            aria-modal="true"
            className={`ui-dialog ui-dialog--${size}`}
            onCloseAutoFocus={focus.onCloseAutoFocus}
            onEscapeKeyDown={(event) => {
              if (!closeOnEscape) event.preventDefault();
            }}
            onOpenAutoFocus={focus.onOpenAutoFocus}
            onPointerDownOutside={(event) => {
              if (!closeOnOverlay) event.preventDefault();
            }}
            role={role}
            {...(description ? {} : { "aria-describedby": undefined })}
          >
            <div className="ui-dialog-head">
              <DialogPrimitive.Title className="ui-dialog-title">{title}</DialogPrimitive.Title>
              {showClose && (
                <DialogPrimitive.Close asChild>
                  <Button aria-label="关闭" size="icon" variant="ghost">
                    <Icon name="x" />
                  </Button>
                </DialogPrimitive.Close>
              )}
            </div>
            {description && (
              <DialogPrimitive.Description className="ui-dialog-desc">
                {description}
              </DialogPrimitive.Description>
            )}
            <div className="ui-dialog-body">{children}</div>
            {footer && <div className="ui-dialog-foot">{footer}</div>}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * 模态对话框：行为层为 Radix Dialog（portal、焦点进入/循环、Escape/外点、hideOthers、
 * labelledby/describedby），本组件补 `aria-modal` 与无 trigger 时的焦点归还；样式映射 demo `.modal`（dialog.css）。
 */
export function Dialog({ dismissible = true, size = "md", ...rest }: DialogProps) {
  return (
    <DialogFrame
      {...rest}
      closeOnEscape={dismissible}
      closeOnOverlay={dismissible}
      role="dialog"
      showClose={dismissible}
      size={size}
    />
  );
}
