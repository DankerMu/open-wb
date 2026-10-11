/**
 * Source previewer: the numbered code table ported from resource/workbuddy-live-demo.html:3910-3938
 * and the JSON pretty-print from 3926. `preview-code` is a stable hook tests and the UI walk select by.
 */
import { fileExtension } from "./kind.js";

export const SCROLL_BODY = "min-h-0 flex-1 overflow-auto";
export const WIDE_TABLE = "w-max min-w-full border-collapse";

function lineDocuments(text: string): { source: number; value: string }[] {
  const lines = text.split("\n");
  let cursor = 0;
  return lines.map((value) => {
    const line = { source: cursor, value };
    cursor += value.length + 1;
    return line;
  });
}

export function CodeView({ text }: { text: string }) {
  return (
    <div className={`${SCROLL_BODY} py-[0.4rem]`} data-slot="preview-code">
      <table className={`${WIDE_TABLE} font-(family-name:--wb-mono) text-[0.75rem] leading-[1.55]`}>
        <tbody>
          {lineDocuments(text).map((line, lineNumber) => (
            <tr key={line.source}>
              <td className="w-[1%] py-0 pr-3 pl-[0.9rem] text-right align-top whitespace-nowrap text-(--wb-text-tertiary) select-none">
                {lineNumber + 1}
              </td>
              <td className="pr-4 whitespace-pre text-(--wb-text-primary)">
                {line.value === "" ? " " : line.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function CodePreviewer({ name, content }: { name: string; content: string }) {
  return <CodeView text={fileExtension(name) === "json" ? prettyJson(content) : content} />;
}
