/**
 * SVG previewer. The fetched text reaches the page only as the `data:` address of an `img`
 * (percent-encoded, no Blob address) and as text nodes of the source view; it is never parsed
 * as markup of this document. 查看源码 / 图片视图 toggles between the two; the source view is this
 * directory's `CodeView`, imported statically. A truncated response is source only: the shell
 * (`preview.tsx`) already renders the truncation line.
 * No icon component here on purpose: it renders an inline vector element, and the tests assert
 * that this module puts none into the document.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeView } from "./code.js";

function SvgImage({ name, content }: { name: string; content: string }) {
  const [showSource, setShowSource] = useState(false);
  // 记的是失败过的那个地址而不是布尔：同一文件取回新内容就是新图，失败态随之解除。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
  const image = (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-(--wb-bg-secondary) p-6">
      {failedSrc === src ? (
        <p className="text-[13px] text-muted-foreground">无法显示该图片</p>
      ) : (
        <img
          alt={name}
          className="max-h-full max-w-full rounded-[8px]"
          onError={() => setFailedSrc(src)}
          src={src}
        />
      )}
    </div>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 justify-end px-4 pt-2">
        <Button
          onClick={() => setShowSource((current) => !current)}
          type="button"
          variant="secondary"
        >
          {showSource ? "图片视图" : "查看源码"}
        </Button>
      </div>
      {showSource ? <CodeView text={content} /> : image}
    </div>
  );
}

export function SvgPreviewer({
  name,
  content,
  truncated,
}: {
  name: string;
  content: string;
  truncated: boolean;
}) {
  return truncated ? <CodeView text={content} /> : <SvgImage content={content} name={name} />;
}
