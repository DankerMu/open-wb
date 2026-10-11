/**
 * 预览监听器（preview-origin「预览监听器」）：独立的 Fastify 实例，与 `server/src/app.ts` 同层的第二个
 * 装配根。只有 `GET`（及其 `HEAD`）`/w/<token>/<path>`；`/o/` 由办公文档那一刀加。
 *
 * 是否放行只看路径里的令牌：这里不注册认证插件与 cookie 解析，不拿数据库句柄，不托管静态文件，
 * 没有 `/api`。每次请求依次核对：令牌未过期 → 空间仍在、仍属该账号、根目录仍是目录 →
 * 路径过 `sandbox.resolve(op=read)` → 目标是普通文件。对监听器的请求不续期令牌。
 *
 * 失败一律是固定的短纯文本加三项公共头，不是 JSON 信封，不含令牌、路径或任何请求内容；
 * 所以框架自己会回显路径的几处（坏百分号序列、超长参数、未命中路由；实测）与缺省错误处理器都被接管。
 *
 * 已知残余（design D22「已知残余」、D-23，#1286 未闭合；以下为读代码推出，未测）：`lstat` 判定为普通文件
 * 之后，文件由区间发送函数按路径打开，不带 `O_NOFOLLOW` / `O_NONBLOCK`。其间条目或中间分量若被换成
 * 符号链接，读到的是链接目标；被换成命名管道，则占住一个线程池线程。这与主站 `file` / `download`
 * 是同一个窗口，本路由是它的第三条；不同之处有二：这里没有字节上限，读到的是目标全文；凭据是
 * 路径里的令牌而不是 cookie。`Content-Length` 取 `lstat` 时的大小，其间文件变短则正文短于声明。
 */
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
import { isOrdinaryDirectory, lstatExisting } from "../workspaces/rest.js";
import type { WorkspaceStore } from "../workspaces/store.js";
import { previewFailureHeaders, previewHeaders } from "./headers.js";
import type { OfficeConverter } from "./office.js";
import type { PreviewTokens } from "./tokens.js";

interface PreviewAppOptions {
  store: Pick<WorkspaceStore, "rootOf">;
  sandbox: Pick<ReturnType<typeof createSandbox>, "resolve">;
  tokens: Pick<PreviewTokens, "lookup">;
  /** `/o/` 的转换器；本模块目前不读它。 */
  converter?: OfficeConverter;
  /** `/o/` 的文档上限；本模块目前不读它，`/w/` 没有大小上限。 */
  limits?: { documentMaxBytes: number };
  /** 与主实例同一含义的 listener 关停预算（毫秒）；省略时取 LISTENER_CLOSE_BUDGET_MS。 */
  listenerCloseBudgetMs?: number;
  /** 仅在预算到期、仍有连接未关而被强制回收时同步调用一次；本模块自身不写任何记录。 */
  onListenerForceClose?: () => void;
}

const NOT_FOUND_TEXT = "预览不存在或已过期";
const DENIED_TEXT = "路径不在工作空间内";
/** 成功响应才有的头：流在打开文件时失败，这些头已经写在 reply 上，500 之前要清掉。 */
const SUCCESS_ONLY_HEADERS = [
  "Access-Control-Allow-Origin",
  "Cross-Origin-Resource-Policy",
  "Content-Security-Policy",
  "Content-Range",
  "Accept-Ranges",
  "Content-Length",
];

/** 所有带文案的失败只经这里：头自己写全，不靠钩子补（`frameworkErrors` 那条路不跑钩子）。 */
function fail(reply: FastifyReply, status: 403 | 404, text: string): FastifyReply {
  return reply.code(status).headers(previewFailureHeaders()).send(text);
}

export function createPreviewApp(options: PreviewAppOptions): FastifyInstance {
  const { store, sandbox, tokens } = options;
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
    // 其余失败（含 lstat 之后文件消失、打开失败）：有状态无文案。框架缺省的处理器把错误消息写进
    // JSON 体（实测）；Node 的打开失败消息里有宿主上的绝对路径（读代码推出）。
    for (const name of SUCCESS_ONLY_HEADERS) {
      reply.removeHeader(name);
    }
    return reply.code(500).headers(previewFailureHeaders()).send();
  });

  app.get<{ Params: { token: string; "*": string } }>("/w/:token/*", (request, reply) => {
    const binding = tokens.lookup(request.params.token, Date.now());
    if (binding === null) {
      return fail(reply, 404, NOT_FOUND_TEXT);
    }
    // 账号与空间只取自令牌的登记，请求里没有任何东西能换掉它们。
    const principal = { id: binding.ownerId };
    const root = store.rootOf(principal, binding.workspaceId);
    // 先于 resolve：根目录不在时 resolve 会当成越界，写一条审计并答 403。
    if (root === null || !isOrdinaryDirectory(root)) {
      return fail(reply, 404, NOT_FOUND_TEXT);
    }
    // 路由器已对通配段解码一次，此处原样使用，不再解码。
    const path = request.params["*"];
    if (path === "") {
      return fail(reply, 404, NOT_FOUND_TEXT);
    }
    // 被拒时沙箱写 sandbox.reject（actor 为令牌的账号）并抛 sandbox_denied。
    const absPath = sandbox.resolve(principal, binding.workspaceId, path, "read");
    const status = lstatExisting(absPath);
    // 目录不列、不找 index.html；管道、套接字、设备同样不是可读的目标。
    if (status === undefined || !status.isFile()) {
      return fail(reply, 404, NOT_FOUND_TEXT);
    }
    return sendFileRange(request, reply, {
      absPath,
      size: status.size,
      // 类型只看文件自己的名字。
      headers: previewHeaders(basename(absPath), binding.embedOrigin),
      unsatisfiableHeaders: previewFailureHeaders(),
    });
  });

  return app;
}
