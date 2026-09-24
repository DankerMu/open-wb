import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactElement } from "react";
import { Icon, type IconName } from "./icon.js";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  danger?: boolean | undefined;
  icon?: IconName | undefined;
};

type MenuProps = {
  /** `Trigger asChild` 的单一元素，须能接 ref（如 `Button`）。 */
  trigger: ReactElement;
  items: readonly MenuItem[];
};

/**
 * 下拉菜单：行为层全部由 Radix DropdownMenu 提供（role=menu/menuitem、roving focus 与上下/Home/End/
 * typeahead、Enter/Space/点击选择、Escape/外点关闭、关闭后焦点归还 trigger），本组件不写键盘/焦点代码。
 * `modal={false}`：外点关闭且点击到达目标，不锁 body 指针事件、不给页面其它元素加 aria-hidden（demo:1056）；
 * `loop` 首尾环绕。样式映射 demo `.menu-pop`/`.menu-item`（menu.css）。
 */
export function Menu({ trigger, items }: MenuProps) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ui-menu" collisionPadding={8} loop sideOffset={6}>
          {items.map((item) => (
            <DropdownMenu.Item
              className={item.danger ? "ui-menu-item ui-menu-item--danger" : "ui-menu-item"}
              key={item.label}
              onSelect={() => item.onSelect()}
            >
              {item.icon && <Icon name={item.icon} size={14} />}
              <span className="ui-menu-item-label">{item.label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
