import type { ComponentPropsWithoutRef } from "react";

export type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
  /** loading 时禁用并显示指示器；label 仍在 DOM 且占位（文字透明），宽度不变。 */
  loading?: boolean;
} & ComponentPropsWithoutRef<"button">;

/** 按钮基元，样式映射 demo `.wb-btn`（button.css）；默认 `type="button"`，调用方可覆盖。 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  disabled,
  type,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    "ui-btn",
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    loading && "ui-btn--loading",
    className,
  ];
  return (
    <button
      {...rest}
      aria-busy={loading || undefined}
      className={classes.filter(Boolean).join(" ")}
      disabled={disabled || loading}
      type={type ?? "button"}
    >
      {loading && <span aria-hidden="true" className="ui-btn-spinner ui-spin" />}
      {children}
    </button>
  );
}
