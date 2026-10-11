/**
 * Markdown previewer: rendered view (lib/markdown-view) with a 查看源码 / 渲染视图 toggle.
 * The toggle state lives here, so it resets whenever the caller remounts the previewer
 * (`preview.tsx` keys it by `path`). The source view is this directory's `CodeView`, imported
 * statically: switching views inside one mount never waits on a chunk.
 * `preview-markdown` is a stable hook tests and the UI walk select by.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "../../../lib/markdown-view.js";
import { CodeView, SCROLL_BODY } from "./code.js";

/**
 * Markdown typography: preflight strips list markers and heading weight, these put them back.
 * No scroll container and no padding in it: the Notebook previewer puts it on each Markdown cell.
 */
export const MARKDOWN_TYPOGRAPHY = [
  "[overflow-wrap:anywhere]",
  "[&_:is(h1,h2,h3,h4)]:mb-[0.6rem] [&_:is(h1,h2,h3,h4)]:leading-[1.35] [&_:is(h1,h2,h3,h4)]:font-bold",
  "[&_h1]:text-[1.35rem] [&_h2]:mt-[1.35rem] [&_h2]:text-[1rem]",
  "[&_:is(h3,h4)]:mt-[1.1rem] [&_:is(h3,h4)]:text-[0.9rem]",
  "[&_:is(p,ul,ol)]:mb-[0.65rem] [&_:is(ul,ol)]:pl-10 [&_ul]:list-disc [&_ol]:list-decimal",
  "[&_li]:my-[0.15rem]",
  "[&_code]:rounded-[4px] [&_code]:bg-(--wb-bg-secondary) [&_code]:px-[0.3rem] [&_code]:py-[0.05rem]",
  "[&_code]:font-(family-name:--wb-mono) [&_code]:text-[0.75rem]",
  "[&_pre]:overflow-auto [&_pre]:rounded-[8px] [&_pre]:border [&_pre]:border-(--wb-border-default)",
  "[&_pre]:bg-(--wb-bg-secondary) [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:w-max [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-[0.8rem]",
  "[&_:is(th,td)]:border [&_:is(th,td)]:border-(--wb-border-default)",
  "[&_:is(th,td)]:px-[0.55rem] [&_:is(th,td)]:py-[0.35rem] [&_:is(th,td)]:text-left",
].join(" ");

const MARKDOWN_BODY = `${SCROLL_BODY} max-w-[52rem] px-5 pt-4 pb-6 ${MARKDOWN_TYPOGRAPHY}`;

function RenderedMarkdownDocument({ text }: { text: string }) {
  return (
    <div className={MARKDOWN_BODY} data-markdown-body="" data-slot="preview-markdown">
      <MarkdownView source={text} />
    </div>
  );
}

function MarkdownPreview({ name, text }: { name: string; text: string }) {
  const [showSource, setShowSource] = useState(false);
  const body = showSource ? (
    <CodeView name={name} text={text} />
  ) : (
    // Replacing a content snapshot avoids React's sibling-placement scan on dense inline updates.
    <RenderedMarkdownDocument key={text} text={text} />
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 justify-end px-4 pt-2">
        <Button
          onClick={() => setShowSource((current) => !current)}
          type="button"
          variant="secondary"
        >
          {showSource ? "渲染视图" : "查看源码"}
        </Button>
      </div>
      {body}
    </div>
  );
}

export function MarkdownPreviewer({ name, content }: { name: string; content: string }) {
  return <MarkdownPreview name={name} text={content} />;
}
