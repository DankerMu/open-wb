/**
 * 出站 multipart（s2a-kb-ragflow D10；knowledge-bases「工作空间来源入库」第 6 步，实测记录 §7.1–§7.3）：一个文件，字段名
 * `file`。长度预先算好，字节流过这里，不缓冲、不落盘，背压经 `pipe` 传到源。组 12（本地上传）与组 14（重建）复用。
 *
 * 文件名只走 `filename*=UTF-8''…`，不写带引号的 `filename`：文件名是用户的，写进引号里就是头注入。`"`、`\`、CR、LF 与
 * `'()*` 由这里百分号编码，头里没有它们的原文。§7.3 只实测了 RAGFlow 解码中文名，这些字符的解码没有实测。百分号串不能放进
 * `filename`：RAGFlow 原样保留，不解码。
 *
 * 字节计数：`size` 是调用方声明的长度，多一个字节都不发。读到的多于或少于 `size` 时销毁请求体，结束边界不发，RAGFlow
 * 不留文档（§7.2）。源读取出错同样销毁。这时 `uploadDocument` 只知道请求体坏了，回 `kb_unavailable`，所以调用点要先问
 * `sourceFailure()`，否则「文件变了」会被当成「服务不可达」。请求体被外部销毁（早应答、连接断开）不算源的失败：它只把
 * 源关掉，源不带错误销毁。
 */
import { randomBytes } from "node:crypto";
import { type Readable, Transform } from "node:stream";

interface MultipartFile {
  /** 文件名，不是路径。 */
  name: string;
  /** 声明的字节数，算进 `Content-Length`。 */
  size: number;
  /** 文件字节。交给这里之后归这里销毁。 */
  source: Readable;
}

interface MultipartUpload {
  body: Readable;
  contentType: string;
  contentLength: number;
  /** 源出错或字节数与声明不符时的错误，否则 `undefined`。 */
  sourceFailure(): unknown;
}

/**
 * RFC 8187 的 attr-char 之外都要编码；`encodeURIComponent` 放过的 `'()*` 进不了 RFC 2045 的 token。先过一次 UTF-8：JSON
 * 能带来孤立代理项，`encodeURIComponent` 对它抛错。
 */
function extendedValue(name: string): string {
  return encodeURIComponent(Buffer.from(name).toString()).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function multipartUpload({ name, size, source }: MultipartFile): MultipartUpload {
  const boundary = `----owb${randomBytes(16).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${extendedValue(name)}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  let failure: unknown;
  let counted = 0;

  const mismatch = (): Error => {
    failure = new Error("source bytes differ from the declared size");
    return failure as Error;
  };
  const body = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      counted += chunk.length;
      if (counted > size) {
        done(mismatch());
      } else {
        done(null, chunk);
      }
    },
    flush(done) {
      if (counted === size) {
        done(null, tail);
      } else {
        done(mismatch());
      }
    },
  });
  body.push(head);
  source.once("error", (error) => {
    failure = error;
    body.destroy(error);
  });
  body.once("close", () => {
    source.destroy();
  });
  source.pipe(body);

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: head.length + size + tail.length,
    sourceFailure: () => failure,
  };
}
