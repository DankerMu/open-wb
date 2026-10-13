/**
 * 预览监听器（preview-origin「预览监听器」）：独立的 Fastify 实例，与 `server/src/app.ts` 同层的第二个
 * 装配根。只有 `GET`（及其 `HEAD`）两条路由：`/w/<token>/<path>` 原样发文件，`/o/<token>/<path>`
 * （office-preview「办公文档预览路由」，#1074）把办公文档交给转换器、发回转换出的 PDF。
 *
 * 是否放行只看路径里的令牌：这里不注册认证插件与 cookie 解析，不拿数据库句柄，不托管静态文件，
 * 没有 `/api`。每次请求依次核对：令牌未过期 → 空间仍在、仍属该账号、根目录仍是目录 →
 * 路径过 `sandbox.resolve(op=read)` → 目标是普通文件。两条路由的这一段是同一个函数。对监听器的
 * 请求不续期令牌。`/o/` 其后再依次：扩展名（最后一个 `.` 之后、转小写）是 `docx` / `xlsx` / `pptx`
 * → 大小不超过文档上限 → 转换器可用 → 入口已清空 `work/` → `convert`，以连接关闭为中止信号。
 * 转换以 `aborted` 落定（客户端断开，或入口关停时转换器 `close()`）时不写任何字节、直接断开连接。
 * `/o/` 不写审计（越界拒绝除外），成功响应的类型恒为 PDF、不带原文件名。
 *
 * 失败一律是固定的短纯文本加三项公共头，不是 JSON 信封，不含令牌、路径或任何请求内容；
 * 所以框架自己会回显路径的几处（坏百分号序列、超长参数、未命中路由；实测）与缺省错误处理器都被接管。
 *
 * 已知残余（design D22「已知残余」、D-23，#1286 未闭合；以下为读代码推出，未测）：`lstat` 判定为普通文件
 * 之后，文件由区间发送函数按路径打开，不带 `O_NOFOLLOW` / `O_NONBLOCK`。其间条目或中间分量若被换成
 * 符号链接，读到的是链接目标；被换成命名管道，则占住一个线程池线程。这与主站 `file` / `download`
 * 是同一个窗口，本路由是它的第三条。与 `file` 的文本 / 图片 / 笔记本分支不同，`/w/` 没有字节上限
 * （`download` 与 `file` 的音视频分支同样没有）；读到的至多是 `lstat` 时 `size` 个字节，该值由换入方
 * 决定。凭据是路径里的令牌而不是 cookie，持令牌者包括被预览文档自己的脚本（成功响应带
 * `Access-Control-Allow-Origin: *`，CSP 允许脚本且不设取源指令，文档地址里就有令牌）：该文档由 omp
 * 侧写入，与能换路径的是同一方，它可以自行重复请求去撞窗口，并把读到的内容发往外部；它也可以把令牌
 * 本身发往外部，此后任何持令牌方（含换路径的 omp 侧进程——生产入口把预览监听器绑在主监听器的
 * `HOST` 上，缺省 `127.0.0.1`，同机的 omp 用户进程连得到这个端口；读代码推出，未测）在令牌有效期内
 * （900 秒，主站每次签发都会续期）都可以直接请求并与自己的替换动作对时，
 * 不限于预览打开期间，也不需要浏览器；`file` / `download` 的字节只回到带 cookie 的主站页面。`/w/` 的
 * 成功读取不写审计行（`download` 写 `file.download`）。`Content-Length` 取 `lstat` 时的大小，其间
 * 文件变短则正文短于声明。
 *
 * `/o/`（#1074）是这个读窗口的第四条路由，有两段，同样没有闭合（除标明实测的一句外，以下为读代码推出，未测）：
 * ① `resolve` / `lstat` 判定之后，转换进程才按路径打开输入。排队把这段间隔从毫秒级拉长到最坏约
 *    `ceil(8 / concurrency) × timeoutMs`（缺省并发 2、超时 60 秒时约 4 分钟，并发为 1 时约 8 分钟）。
 *    其间条目或中间分量被换成符号链接时，转换进程读的是链接目标；文档上限比的是 `lstat` 那一刻的
 *    大小，换入的内容不受它约束（输出仍受 200 MiB 上限）。读的一方在 `OMP_USER` 模式下是 omp
 *    用户，同 uid 模式下是应用用户——后者读得到应用用户够得着的任何文件，转换结果经本路由回到
 *    持令牌方。
 *    与换路径的窗口无关的另一条：**文档内容所引用**的资源（链接的图片、外部数据、`file://` 地址）
 *    由转换进程去取，可能经转换出的 PDF 到达持令牌方。本地引用：同 uid 模式下由应用用户读，
 *    `OMP_USER` 模式下由 omp 用户读（含其它账号的工作空间）；uid 分离只缓解前者里应用用户独有的
 *    部分（数据库、密钥）。网络引用：从服务器所在的网络位置发出，两种模式相同，没有缓解。
 *    LibreOffice headless 是否跟随这类引用（#1350；2026-10-12，一次性容器里按 `office.ts` 的 argv、环境与
 *    `sudo … setpriv` 形状复刻调用，LibreOffice 24.2.7.2，未经 `/o/` 路由）：链接图片**被跟随**（实测）——
 *    docx 的 http 图片、docx / pptx 的 `file://` 图片都被取回并进了输出的 PDF；读的一方就是转换进程的
 *    uid，两种模式各自读不到对方 `0600` 的文件，但都读到了另一账号工作空间里的图。外部数据类（xlsx
 *    外部工作簿引用、`WEBSERVICE()`、DDE、链接 OLE、docx `INCLUDETEXT`）：未测，跟随与否未知，所以
 *    「任意本地文本文件能否进 PDF」同样未知；已证实能进 PDF 的只是能被当作图片解码的文件。https、回环
 *    以外的网络目标（实测的 http 目标是容器内回环监听器）、DNS 与重定向、xlsx 里的链接图片、关闭链接
 *    更新之后的行为、其它版本：未测。
 * ② `convert` 落定之后，路由对缓存里的 PDF 再 `lstat`，由区间发送函数按路径打开，同样不带
 *    `O_NOFOLLOW` / `O_NONBLOCK`。`pdf/` 为 `0700`、属应用用户，omp 用户进不去；能换这一段的只有
 *    以应用用户身份运行的代码。
 * 凭据与 `/w/` 相同（路径里的令牌，持令牌方的范围见上），成功的转换同样不写审计行。
 */
import type { Socket } from "node:net";
import { basename } from "node:path";
import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { HttpError } from "../core/errors/index.js";
import type { createSandbox } from "../core/sandbox/index.js";
import {
  LISTENER_CLOSE_BUDGET_MS,
  registerListenerShutdown,
  validateListenerCloseBudget,
} from "../http/listener-shutdown.js";
import { sendFileRange } from "../workspaces/range-send.js";
import { isOrdinaryDirectory, lstatExisting, ownedRootOf } from "../workspaces/rest.js";
import type { WorkspaceStore } from "../workspaces/store.js";
import { previewFailureHeaders, previewHeaders } from "./headers.js";
import { OfficeConvertError, type OfficeConverter } from "./office.js";
import type { PreviewTokens } from "./tokens.js";

interface PreviewAppOptions {
  store: Pick<WorkspaceStore, "rootOf">;
  sandbox: Pick<ReturnType<typeof createSandbox>, "resolve">;
  tokens: Pick<PreviewTokens, "lookup">;
  /** `/o/` 的转换器（生产入口给的是包了缓存与排队的那一个）。本模块不 `close()` 它。 */
  converter: Pick<OfficeConverter, "available" | "convert">;
  /** `/o/` 的文档上限（字节）；必填——缺了就等于没有上限。`/w/` 没有大小上限。 */
  limits: { documentMaxBytes: number };
  /**
   * `/o/` 此刻可否启动转换：入口在启动时对 `work/` 的清空落定之前给 `false`（那条清空会删掉在途
   * 转换的作业目录）。省略即恒为可以。
   */
  officeReady?: () => boolean;
  /** 与主实例同一含义的 listener 关停预算（毫秒）；省略时取 LISTENER_CLOSE_BUDGET_MS。 */
  listenerCloseBudgetMs?: number;
  /** 仅在预算到期、仍有连接未关而被强制回收时同步调用一次；本模块自身不写任何记录。 */
  onListenerForceClose?: () => void;
}

const NOT_FOUND_TEXT = "预览不存在或已过期";
const DENIED_TEXT = "路径不在工作空间内";
/** office-preview「办公文档预览路由」的失败表，逐字。 */
const UNSUPPORTED_TEXT = "该类型不支持转换";
const TOO_LARGE_TEXT = "文件超过预览上限，请下载后查看";
const UNAVAILABLE_TEXT = "服务器未启用文档转换，请下载后查看";
const BUSY_TEXT = "文档转换繁忙，请稍后重试";
const FAILED_TEXT = "文档转换失败，请下载后查看";
const TIMEOUT_TEXT = "文档转换超时，请下载后查看";
const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set(["docx", "xlsx", "pptx"]);
/** 响应里 PDF 的名字：类型只由它算出，原文件名不进任何头。 */
const PDF_NAME = "a.pdf";
/** 成功响应才有的头：流在打开文件时失败，这些头已经写在 reply 上，500 之前要清掉。 */
const SUCCESS_ONLY_HEADERS = [
  "Access-Control-Allow-Origin",
  "Cross-Origin-Resource-Policy",
  "Content-Security-Policy",
  "Content-Range",
  "Accept-Ranges",
  "Content-Length",
];

type FailureStatus = 403 | 404 | 413 | 415 | 502 | 503 | 504;

/** 所有带文案的失败只经这里：头自己写全，不靠钩子补（`frameworkErrors` 那条路不跑钩子）。 */
function fail(reply: FastifyReply, status: FailureStatus, text: string): FastifyReply {
  return reply.code(status).headers(previewFailureHeaders()).send(text);
}

/** 转换失败的种类到状态与文案；`aborted` 不在表里——那种情况不写响应。 */
function convertFailure(kind: OfficeConvertError["kind"]): [FailureStatus, string] {
  switch (kind) {
    case "unavailable":
      return [503, UNAVAILABLE_TEXT];
    case "busy":
      return [503, BUSY_TEXT];
    case "timeout":
      return [504, TIMEOUT_TEXT];
    default:
      return [502, FAILED_TEXT];
  }
}

/** 文件名最后一个 `.` 之后的部分，转小写；没有 `.` 即空串。不裁空白：`a.docx ` 的扩展名带着那个空格。 */
function extensionOf(absPath: string): string {
  const name = basename(absPath);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function createPreviewApp(options: PreviewAppOptions): FastifyInstance {
  const { store, sandbox, tokens, converter, limits } = options;
  const officeReady = options.officeReady ?? ((): boolean => true);
  const app = fastify({
    logger: false,
    // 坏百分号序列与超长的 `:token`：框架缺省答 400 / 414，JSON 体里带着整条路径（实测）。
    frameworkErrors: (_error, _request, reply) => fail(reply, 404, NOT_FOUND_TEXT),
  });
  // 必须紧跟 fastify()：其 preClose 是第一个根 hook（理由见 http/listener-shutdown）。
  registerListenerShutdown(
    app,
    validateListenerCloseBudget(options.listenerCloseBudgetMs ?? LISTENER_CLOSE_BUDGET_MS),
    options.onListenerForceClose,
  );

  // 方法在这里拒绝：留给未命中处理器的话框架先解析请求体，带 `text/xml` 体的 POST 成了 500（实测）。
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fail(reply, 404, NOT_FOUND_TEXT);
    }
  });
  app.setNotFoundHandler((_request, reply) => fail(reply, 404, NOT_FOUND_TEXT));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError && error.code === "sandbox_denied") {
      return fail(reply, 403, DENIED_TEXT);
    }
    if (error instanceof HttpError && error.code === "not_found") {
      return fail(reply, 404, NOT_FOUND_TEXT);
    }
    // 其余失败（含 lstat 之后文件消失、打开失败、转换器抛出种类之外的错误）：有状态无文案。框架
    // 缺省的处理器把错误消息写进 JSON 体（实测）；Node 的打开失败消息里有宿主上的绝对路径（读代码推出）。
    for (const name of SUCCESS_ONLY_HEADERS) {
      reply.removeHeader(name);
    }
    return reply.code(500).headers(previewFailureHeaders()).send();
  });

  /**
   * `/w/` 与 `/o/` 共用的前半段，次序固定：令牌 → 空间根 → 空路径 → `resolve(op=read)` → `lstat`
   * 为普通文件。不成立时这里已经写了 404（`reply` 已发送）并返回 `null`；越界由 `resolve` 抛
   * `sandbox_denied`，上面的错误处理器答 403。
   */
  function locate(params: { token: string; "*": string }, reply: FastifyReply) {
    const binding = tokens.lookup(params.token, Date.now());
    if (binding === null) {
      fail(reply, 404, NOT_FOUND_TEXT);
      return null;
    }
    // 账号与空间只取自令牌的登记，请求里没有任何东西能换掉它们。
    const principal = { id: binding.ownerId };
    // 根路径被非目录占据时这里抛 `not_found`，由上面的错误处理器答与下一行相同的 404（#1244）；根是
    // 符号链接等其余失败原样抛出，仍是无文案的 500。
    const root = ownedRootOf(store, principal, binding.workspaceId);
    // 先于 resolve：根目录不在时 resolve 会当成越界，写一条审计并答 403。
    if (root === null || !isOrdinaryDirectory(root)) {
      fail(reply, 404, NOT_FOUND_TEXT);
      return null;
    }
    // 路由器已对通配段解码一次，此处原样使用，不再解码。
    const path = params["*"];
    if (path === "") {
      fail(reply, 404, NOT_FOUND_TEXT);
      return null;
    }
    // 被拒时沙箱写 sandbox.reject（actor 为令牌的账号）并抛 sandbox_denied。
    const absPath = sandbox.resolve(principal, binding.workspaceId, path, "read");
    const status = lstatExisting(absPath);
    // 目录不列、不找 index.html；管道、套接字、设备同样不是可读的目标。
    if (status === undefined || !status.isFile()) {
      fail(reply, 404, NOT_FOUND_TEXT);
      return null;
    }
    return { absPath, size: status.size, embedOrigin: binding.embedOrigin };
  }

  app.get<{ Params: { token: string; "*": string } }>("/w/:token/*", (request, reply) => {
    const target = locate(request.params, reply);
    if (target === null) {
      return reply;
    }
    return sendFileRange(request, reply, {
      absPath: target.absPath,
      size: target.size,
      // 类型只看文件自己的名字。
      headers: previewHeaders(basename(target.absPath), target.embedOrigin),
      unsatisfiableHeaders: previewFailureHeaders(),
    });
  });

  /**
   * `/o/` 在转换之前的四项拒绝，次序固定（office-preview「办公文档预览路由」与场景「拒绝在转换
   * 之前」）：扩展名 → 大小 → 转换器可用 → 入口已就绪。都不成立时返回 `null`。
   */
  function refusalOf(target: { absPath: string; size: number }): [FailureStatus, string] | null {
    if (!OFFICE_EXTENSIONS.has(extensionOf(target.absPath))) {
      return [415, UNSUPPORTED_TEXT];
    }
    // 恰等于上限的放行。这是 `lstat` 那一刻的大小（见头注释的已知残余）。
    if (target.size > limits.documentMaxBytes) {
      return [413, TOO_LARGE_TEXT];
    }
    // 路由自己判，不靠 `convert` 抛 `unavailable`。
    if (!converter.available) {
      return [503, UNAVAILABLE_TEXT];
    }
    return officeReady() ? null : [503, BUSY_TEXT];
  }

  /**
   * 调 `convert`，连接关闭即中止它。听的是 socket 的 `close`，不是 `request.raw` 的（后者在请求
   * 正常收完时也触发——读 Node 文档推出，未测）。keep-alive 连接复用同一个 socket：`convert` 落定
   * 就摘掉监听。带种类的失败作为值返回，其余错误原样抛给错误处理器（无文案的 500）。
   */
  async function convertWhileConnected(
    socket: Socket,
    absPath: string,
  ): Promise<string | OfficeConvertError> {
    const disconnected = new AbortController();
    const onClose = (): void => disconnected.abort();
    socket.once("close", onClose);
    if (socket.destroyed) {
      disconnected.abort();
    }
    try {
      return await converter.convert(absPath, disconnected.signal);
    } catch (error) {
      if (error instanceof OfficeConvertError) {
        return error;
      }
      throw error;
    } finally {
      socket.off("close", onClose);
    }
  }

  app.get<{ Params: { token: string; "*": string } }>("/o/:token/*", async (request, reply) => {
    const target = locate(request.params, reply);
    if (target === null) {
      return reply;
    }
    const refusal = refusalOf(target);
    if (refusal !== null) {
      return fail(reply, ...refusal);
    }
    const outcome = await convertWhileConnected(request.raw.socket, target.absPath);
    if (outcome instanceof OfficeConvertError) {
      if (outcome.kind === "aborted") {
        // 客户端已断开，或转换器正在关停：不写任何字节，直接断开连接。
        reply.hijack();
        request.raw.destroy();
        return reply;
      }
      return fail(reply, ...convertFailure(outcome.kind));
    }
    const converted = lstatExisting(outcome);
    // 缓存文件刚被周期清理删掉：按转换失败答。
    if (converted === undefined || !converted.isFile()) {
      return fail(reply, 502, FAILED_TEXT);
    }
    return sendFileRange(request, reply, {
      absPath: outcome,
      size: converted.size,
      // 固定的名字：类型恒为 PDF（CSP 因此不带 `sandbox`），原文件名不参与。
      headers: previewHeaders(PDF_NAME, target.embedOrigin),
      unsatisfiableHeaders: previewFailureHeaders(),
    });
  });

  return app;
}
