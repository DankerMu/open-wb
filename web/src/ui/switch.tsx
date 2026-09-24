import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";

type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

/**
 * 开关基元：Radix Switch（role=switch、aria-checked、data-state 由 Radix 提供），
 * 样式映射 demo `.switch`（switch.css）。受控/非受控（`checked` / `defaultChecked`）均透传。
 */
export function Switch({ className, ...rest }: SwitchProps) {
  return (
    <SwitchPrimitive.Root {...rest} className={className ? `ui-switch ${className}` : "ui-switch"}>
      <SwitchPrimitive.Thumb className="ui-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
