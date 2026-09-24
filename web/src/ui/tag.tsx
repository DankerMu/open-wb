import type { ComponentProps } from "react";

export type TagProps = {
  tone?: "brand" | "success" | "warning" | "error" | "neutral";
} & ComponentProps<"span">;

/** 标签基元，样式映射 demo `.tag`（tag.css）。 */
export function Tag({ tone = "neutral", className, ...rest }: TagProps) {
  const root = `ui-tag ui-tag--${tone}`;
  return <span {...rest} className={className ? `${root} ${className}` : root} />;
}
