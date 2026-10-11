/**
 * Image previewer. `content` is a Blob URL the caller owns; this module never allocates or
 * revokes one.
 */
export function ImagePreviewer({ name, content }: { name: string; content: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-(--wb-bg-secondary) p-6">
      <img alt={name} className="max-h-full max-w-full rounded-[8px]" src={content} />
    </div>
  );
}
