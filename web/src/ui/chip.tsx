import type { ComponentPropsWithoutRef } from "react";

type ChipProps = {
  selected?: boolean;
  onSelect?: () => void;
} & Omit<ComponentPropsWithoutRef<"button">, "onClick" | "onSelect" | "type">;

/** 可选中 chip，样式只映射 demo `.filter-chip`（chip.css）；选中态经 `aria-pressed` 暴露。 */
export function Chip({ selected = false, onSelect, className, ...rest }: ChipProps) {
  const classes = ["ui-chip", selected && "ui-chip--selected", className];
  return (
    <button
      {...rest}
      aria-pressed={selected}
      className={classes.filter(Boolean).join(" ")}
      onClick={onSelect}
      type="button"
    />
  );
}
