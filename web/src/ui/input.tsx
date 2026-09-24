import type { ComponentPropsWithoutRef } from "react";
import { Icon } from "./icon.js";

type InputProps = { variant?: "search" } & ComponentPropsWithoutRef<"input">;

/**
 * 输入框基元，样式映射 demo `.wb-input`（input.css）。`variant="search"` 渲染带搜索图标的
 * 容器，原生属性透传给内层 `type="search"` 输入框，`className` 落在根元素。
 * 可访问名由调用方经 `aria-label`/`placeholder` 提供。
 */
export function Input({ variant, className, ...rest }: InputProps) {
  if (variant !== "search") {
    return <input {...rest} className={className ? `ui-input ${className}` : "ui-input"} />;
  }
  const root = "ui-input ui-input--search";
  return (
    <div className={className ? `${root} ${className}` : root}>
      <Icon name="search" size={14} />
      <input {...rest} className="ui-input-search-field" type="search" />
    </div>
  );
}
