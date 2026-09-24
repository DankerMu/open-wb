type BrandMarkProps = {
  size?: number;
  wordmark?: boolean;
};

/**
 * 自有品牌标记：圆角方块 + 对勾，几何取自既有 `.brand-mark`（styles.css，
 * 28×28 圆角 8、9×15 边框对勾绕中心旋转 40°）的 SVG 化；不含任何上游品牌资产。
 * 有字标时 svg 退为装饰，可访问名由字标文本提供。
 */
export function BrandMark({ size = 28, wordmark = false }: BrandMarkProps) {
  const mark = (
    <svg
      aria-hidden={wordmark ? "true" : undefined}
      aria-label={wordmark ? undefined : "WorkBuddy"}
      className="ui-brand-mark"
      height={size}
      role={wordmark ? undefined : "img"}
      viewBox="0 0 28 28"
      width={size}
    >
      <rect className="ui-brand-mark-bg" height="28" rx="8" width="28" />
      <path
        className="ui-brand-mark-check"
        d="M10 17.8H17.8V4"
        fill="none"
        strokeWidth="2.4"
        transform="rotate(40 14.5 11.5)"
      />
    </svg>
  );
  if (!wordmark) return mark;
  return (
    <span className="ui-brand">
      {mark}
      <span className="ui-brand-wordmark">WorkBuddy</span>
    </span>
  );
}
