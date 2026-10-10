/**
 * Empty-state block shared by the tree (empty root), the page (no workspace) and the preview
 * (nothing selected, unsupported type). `data-slot` names are the stable hooks tests select by.
 */
export function EmptyState({ description, title }: { description: string; title: string }) {
  return (
    <div
      className="flex min-w-0 flex-col items-center justify-center gap-2.5 px-5 py-14 text-center text-(--wb-text-secondary)"
      data-slot="empty-state"
    >
      <p className="text-[14px] font-medium">{title}</p>
      <p className="text-[12.5px] [overflow-wrap:anywhere]" data-slot="empty-state-desc">
        {description}
      </p>
    </div>
  );
}
