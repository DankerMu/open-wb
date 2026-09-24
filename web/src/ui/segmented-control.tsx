import * as RadioGroup from "@radix-ui/react-radio-group";

type SegmentedControlProps<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  /** radiogroup 的可访问名。 */
  label: string;
};

/**
 * 分段控件：行为层为 Radix RadioGroup（role=radiogroup/radio、aria-checked/data-state、
 * roving focus 与方向键切换且首尾环绕）。选中态样式挂 `[data-state="checked"]`
 * （demo `.seg`，segmented-control.css）。
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
}: SegmentedControlProps<T>) {
  return (
    <RadioGroup.Root
      aria-label={label}
      className="ui-seg"
      onValueChange={(next) => onValueChange(next as T)}
      value={value}
    >
      {options.map((option) => (
        <RadioGroup.Item className="ui-seg-item" key={option.value} value={option.value}>
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
