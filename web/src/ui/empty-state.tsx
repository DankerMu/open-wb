import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon.js";

type EmptyStateProps = {
  icon?: IconName | undefined;
  title: ReactNode;
  description?: ReactNode;
  /** 操作区，置于说明之后。 */
  children?: ReactNode;
};

/** 空态：可选图标容器 + 标题 + 可选说明 + 可选操作区。样式映射 demo `.empty-state`（empty-state.css）。 */
export function EmptyState({ icon, title, description, children }: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      {icon && (
        <div className="ui-empty-state-icon">
          <Icon name={icon} size={20} />
        </div>
      )}
      <p className="ui-empty-state-title">{title}</p>
      {description && <p className="ui-empty-state-desc">{description}</p>}
      {children}
    </div>
  );
}
