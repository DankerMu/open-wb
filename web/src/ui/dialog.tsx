import * as DialogPrimitive from "@radix-ui/react-dialog";
import { type ReactElement, type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
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

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 忙碌上升沿的焦点救回：活动元素是内容内已禁用控件，或已被 focus fixup 到 body 时，移到内容内首个可用控件。
 * 活动元素是内容内可用控件、或在内容外的其他元素（非 fixup 造成）时不动；`busy` 保持为 true 的后续渲染不触发。
 *
 * 时序与两个分支：Chromium（实测 151，Playwright 1.62 自带）在设置 `disabled` 的当下同步把焦点 fixup 到
 * body，所以 commit 后的 layout effect 看到的已是 `body`，走 body 分支（ui-walk 退出段即此路径）。
 * 「内容内已禁用」分支给 fixup 延后（如经 `ClearFocusedElementSoon` 0 延迟定时器任务的 Blink 路径）或
 * 不做 fixup（jsdom）的环境：离散事件的 commit 与 layout effect 在该定时器任务之前跑完。用 layout effect
 * 是为了与禁用同一次 commit、在绘制与下一次按键之前完成救回（`auth/provider.tsx:375` 的 setState 在
 * `await` 之前）。
 *
 * `wasBusy` 实际只在 mount 时起作用：依赖是 `[busy, content]`，`content` 是稳定的 ref，effect 只在
 * `busy` 变化时重跑。以 `busy=true` 首次挂载不救回；且 Radix Portal 首次 commit 时内容尚未挂上，`root` 为 null。
 */
function useBusyFocusRescue(content: RefObject<HTMLElement | null>, busy: boolean) {
  const wasBusy = useRef(busy);
  useLayoutEffect(() => {
    const rising = busy && !wasBusy.current;
    wasBusy.current = busy;
    const root = content.current;
    if (!rising || !root) return;
    const active = document.activeElement;
    const lost =
      active === null ||
      active === document.body ||
      (root.contains(active) && (active as HTMLButtonElement).disabled === true);
    if (lost) root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [busy, content]);
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
  /**
   * 忙碌期（如提交中）由调用方传入；由 false 变 true 时，若焦点所在控件被禁用（或已被 fixup 到 body），
   * 就把焦点救回内容内首个可用控件，防止焦点逃出模态。
   */
  busy?: boolean | undefined;
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
  busy,
}: DialogFrameProps) {
  const focus = useFocusHandoff({ initialFocus, returnFocus, hasTrigger: Boolean(trigger) });
  const contentRef = useRef<HTMLDivElement>(null);
  useBusyFocusRescue(contentRef, busy ?? false);
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
            ref={contentRef}
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
