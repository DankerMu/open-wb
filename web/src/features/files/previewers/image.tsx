/**
 * Image previewer. `content` is a Blob URL the caller owns; this module never allocates one.
 * The one exception to "the caller revokes": when the `img` reports `error`, this module
 * revokes that address right away and shows 无法显示该图片 instead of the broken image.
 * The owner (`tree.tsx`) is not told, so it revokes the same address again on replace or
 * unmount. That second call being a no-op is derived from the File API text (revoking an
 * address that is not in the blob URL store does nothing); it is not pinned by a test here,
 * because jsdom has no implementation of it.
 */
import { useState } from "react";

export function ImagePreviewer({ name, content }: { name: string; content: string }) {
  // 记的是出错的那个地址而不是布尔：同一路径取回新地址就是新图，失败态随之解除。
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-(--wb-bg-secondary) p-6">
      {brokenUrl === content ? (
        <p className="text-[13px] text-muted-foreground">无法显示该图片</p>
      ) : (
        <img
          alt={name}
          className="max-h-full max-w-full rounded-[8px]"
          onError={() => {
            URL.revokeObjectURL(content);
            setBrokenUrl(content);
          }}
          src={content}
        />
      )}
    </div>
  );
}
