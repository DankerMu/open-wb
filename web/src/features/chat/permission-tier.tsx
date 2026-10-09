// 权限档位控件（session-permission-tier「权限档位控件」）：能力行左组的第三项。档位字面量就是 omp 的
// 审批模式，这里只管界面名、说明、`全部自动` 的确认与提交在途的禁用；显示值恒为传入的 `mode`。
import { useLayoutEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatSession } from "../../lib/session-contract.js";
import { Icon, useEscapeFallback } from "../../ui/index.js";

type Mode = ChatSession["approvalMode"];

const TIERS: Record<Mode, { label: string; note: string }> = {
  "always-ask": { label: "每次都问", note: "写文件与执行命令前都要你确认" },
  write: { label: "只问命令", note: "执行命令前要你确认，写文件不用" },
  yolo: { label: "全部自动", note: "不经确认执行命令与修改文件" },
};

type PermissionTierProps = {
  /** 当前档位：已选会话是服务端视图里的值，欢迎态是页面内存里的值。按钮只显示它，不做乐观更新。 */
  mode: Mode;
  /** 可用档位（`options.approvalModes`），菜单按此次序只列这些；`mode` 不在其中时没有选中项。 */
  modes: readonly Mode[];
  /** 提交一次选择；返回的 promise 落定（或同步返回）即解除本控件的在途禁用。 */
  onChange(mode: Mode): Promise<void> | void;
};

/**
 * 按钮 + 单选菜单 + `全部自动` 的确认框。选中当前档位只关菜单；选 `全部自动` 先确认，`确认切换` 才提交，
 * 其余档位直接提交。只在自己的提交在途时禁用，不随输入框锁定禁用（生成中可改）。在途与确认态是组件内
 * 状态：调用方以会话 id 为 `key`，换会话即复位——为甲打开的确认不会提交到乙。
 */
export function PermissionTier({ mode, modes, onChange }: PermissionTierProps) {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** 菜单是因为要弹确认框才关的：这一次不把焦点还给按钮（确认框自己接管焦点）。 */
  const handoff = useRef(false);
  const settled = useRef(true);

  // 在途时按钮禁用，菜单或确认框归还的焦点落不到它上面：落定的那次提交里补上，不让焦点留在 body。
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!pending && !settled.current && (active === document.body || active === null)) {
      triggerRef.current?.focus();
    }
    settled.current = !pending;
  }, [pending]);

  const submit = (next: Mode) => {
    setPending(true);
    void Promise.resolve(onChange(next)).then(() => setPending(false));
  };
  const warned = mode === "yolo";

  return (
    <>
      <DropdownMenu>
        {/* 禁用写在 Trigger 上（它转给按钮）：菜单在 pointerdown 就打开，只禁用按钮挡不住。 */}
        <DropdownMenuTrigger asChild disabled={pending}>
          <Button
            aria-label={`权限：${TIERS[mode].label}`}
            className={`flex-none font-normal ${warned ? "bg-(--wb-status-warning-soft-bg) text-(--wb-status-warning-text)" : "text-muted-foreground"}`}
            data-tier={mode}
            ref={triggerRef}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Icon name="shield" size={14} />
            {TIERS[mode].label}
            <Icon name="chevron-down" size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-72 max-w-(--radix-dropdown-menu-content-available-width)"
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (!handoff.current) return;
            handoff.current = false;
            event.preventDefault();
          }}
          side="top"
        >
          <DropdownMenuRadioGroup
            onValueChange={(value) => {
              const next = value as Mode;
              if (next === mode) return;
              if (next !== "yolo") return submit(next);
              handoff.current = true;
              setConfirming(true);
            }}
            value={mode}
          >
            {modes.map((item) => (
              <DropdownMenuRadioItem
                className="flex-col items-start gap-0 text-[13px] leading-5"
                key={item}
                value={item}
              >
                <span className="font-medium">{TIERS[item].label}</span>
                <span className="text-xs text-muted-foreground">{TIERS[item].note}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <p className="m-0 border-t px-1.5 pt-1.5 pb-1 text-xs text-muted-foreground">
            更改从下一条消息起生效
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirming ? (
        <YoloConfirm
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            submit("yolo");
          }}
          restoreFocus={() => triggerRef.current?.focus()}
        />
      ) : null}
    </>
  );
}

type YoloConfirmProps = { onClose(): void; onConfirm(): void; restoreFocus(): void };

/** `全部自动` 的确认框：`取消` 与 Escape 关闭且不提交，遮罩点击不关闭；只有 `确认切换` 提交。 */
function YoloConfirm({ onClose, onConfirm, restoreFocus }: YoloConfirmProps) {
  const fallback = useEscapeFallback({
    canClose: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  return (
    <AlertDialog onOpenChange={onClose} open>
      <AlertDialogContent
        aria-modal="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>切换到全部自动？</AlertDialogTitle>
          <AlertDialogDescription>助手将不经确认直接执行命令与修改文件。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <Button onClick={onConfirm}>确认切换</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
