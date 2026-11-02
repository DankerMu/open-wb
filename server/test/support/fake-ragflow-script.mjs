/**
 * 假 RAGFlow 的脚本层（`fake-ragflow.mjs` 的兄弟文件，design D17）：用例按路由接管应答。
 *
 * - `answer()`：协议应答，HTTP 状态与 `code` 只收实测记录里出现过的配对。版本接口以外的路由先过鉴权（§12），
 *   被挡下的请求不消耗脚本。
 * - `fault()`：故障注入，种类是闭集，只限 tasks.md 头部的四种：传输层（`hang`、`hold`、`reset`、`cut`、`stall`）、
 *   HTTP 层（`redirect`、`status`、`not_json`、`oversize`）、漂移值（`version`）、防御性组合（`combo`）。正文里的
 *   `code` 同样只收记录里的值，所以 `108`、`109` 进不来；`not_json` 的正文必须真不是 JSON。故障不过鉴权。
 *
 * 一条脚本缺省生效一次，先登记的先生效，用完恢复正常。`hold` 放行后请求走正常路由。
 */
export const JSON_TYPE = "application/json; charset=utf-8";

/** 路由处理函数的两种应答：HTTP 状态缺省 200，所以 `{status, ...failure()}` 才是非 200。 */
export const failure = (code, message, extra = {}) => ({
  json: { code, data: null, message, ...extra },
});
export const success = (data, message = "success") => ({ json: { code: 0, data, message } });

/** 记录里出现过的 body code（§3–§12）。 */
const RECORDED_CODES = new Set([0, 100, 101, 102, 103, 400, 401, 403, 404, 409, 500, 501]);
/** §12：HTTP 200 之外的配对，状态与 `code` 相同。 */
const NON_200_PAIRS = new Set([400, 401, 404]);
/** tasks.md 头部的防御性组合：`0` 是成功应答缺字段，`401` 是 HTTP 200 的 `code:401`。 */
const COMBO_CODES = new Set([0, 100, 101, 102, 401, 403]);
const BODY_CODE = /"code"\s*:\s*"?(\d+)/gu;

export function send(response, reply) {
  if (reply.bytes !== undefined) {
    response.writeHead(reply.status ?? 200, {
      ...reply.headers,
      "content-length": reply.bytes.length,
      "x-api-source": "go",
    });
    response.end(reply.bytes);
    return;
  }
  const bytes = Buffer.from(JSON.stringify(reply.json));
  send(response, { status: reply.status, bytes, headers: { "content-type": JSON_TYPE } });
}

/** 调用方没给长度时，长度大于正文：不走 chunked，§9 的下载始终带 `Content-Length`。 */
function partial(response, fault) {
  const length = Buffer.byteLength(fault.body) + 1;
  response.writeHead(200, {
    "content-type": JSON_TYPE,
    "content-length": length,
    ...fault.headers,
  });
  response.write(fault.body);
}

function plain(response, status, body, headers = {}) {
  const bytes = Buffer.from(body);
  send(response, { status, bytes, headers: { "content-type": "text/plain", ...headers } });
}

function paddedEnvelope(fault) {
  const text = JSON.stringify(fault.envelope ?? { code: 0, data: null, message: "success" });
  return Buffer.from(text.padEnd(fault.bytes, " "));
}

const FAULTS = {
  hang() {},
  reset(response) {
    response.socket?.destroy();
  },
  cut(response, fault) {
    partial(response, fault);
    response.flushHeaders();
    setImmediate(() => response.socket?.destroy());
  },
  stall: partial,
  redirect(response, fault) {
    plain(response, fault.status ?? 302, fault.body ?? "", { location: fault.location });
  },
  status(response, fault) {
    plain(response, fault.status, fault.body ?? "upstream error", fault.headers);
  },
  not_json(response, fault) {
    plain(response, fault.status, fault.body ?? "<html>not json</html>");
  },
  oversize(response, fault) {
    send(response, { bytes: paddedEnvelope(fault), headers: { "content-type": JSON_TYPE } });
  },
  version(response, fault) {
    send(response, { json: { code: 0, data: fault.value, message: "success" } });
  },
  combo(response, fault) {
    const json = fault.deletedList
      ? { code: 0, data: { deleted: [] }, message: null }
      : { code: fault.code, data: fault.data ?? null, message: fault.message ?? null };
    send(response, { json });
  },
};

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 缺省时 `FAULTS.redirect` 回 302。 */
function isRedirectStatus(status) {
  return status === undefined || (status >= 300 && status < 400);
}

function assertBodyCodes(fault) {
  const text = `${fault.body ?? ""}${JSON.stringify(fault.envelope) ?? ""}`;
  for (const [, code] of text.matchAll(BODY_CODE)) {
    if (!RECORDED_CODES.has(Number(code))) {
      throw new Error(`${fault.kind} body code ${code} is not in the rc2 record`);
    }
  }
}

function assertFault(fault) {
  if (fault.kind !== "hold" && !Object.hasOwn(FAULTS, fault.kind)) {
    throw new Error(`fake-ragflow has no fault kind ${String(fault.kind)}`);
  }
  if (fault.kind === "combo" && fault.deletedList !== true && !COMBO_CODES.has(fault.code)) {
    throw new Error(
      `fake-ragflow combo takes 0, 100, 101, 102, 401 or 403, not ${String(fault.code)}`,
    );
  }
  if (fault.kind === "redirect" && !isRedirectStatus(fault.status)) {
    throw new Error(`fake-ragflow redirect fault takes 3xx, not ${String(fault.status)}`);
  }
  if (fault.kind === "status" && !(fault.status >= 500 && fault.status < 600)) {
    throw new Error(`fake-ragflow status fault takes 5xx, not ${String(fault.status)}`);
  }
  if (fault.kind === "not_json" && fault.body !== undefined && isJson(fault.body)) {
    throw new Error("fake-ragflow not_json body must not be JSON");
  }
  assertBodyCodes(fault);
}

function assertRecordedPair(status = 200, code) {
  const paired = status === 200 ? code !== 401 : status === code && NON_200_PAIRS.has(status);
  if (!RECORDED_CODES.has(code) || !paired) {
    throw new Error(`HTTP ${String(status)} + code ${String(code)} is not in the rc2 record`);
  }
}

function routePattern(route) {
  const [method, path] = route.split(" ");
  const escaped = path.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"));
  return { method, pattern: new RegExp(`^${escaped.join("[^/]+")}$`, "u") };
}

function createGate() {
  const { promise: reached, resolve: arrived } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  return { reached, arrived, released, release };
}

export function createScript() {
  const entries = [];
  const gates = new Set();

  function add(route, reply, options) {
    entries.push({ ...routePattern(route), ...reply, times: options?.times ?? 1 });
  }

  function find(method, path) {
    return entries.find(
      (candidate) =>
        candidate.method === method && candidate.pattern.test(path) && candidate.times > 0,
    );
  }

  return {
    answer(route, reply, options) {
      assertRecordedPair(reply.status, reply.code);
      const { status, ...body } = reply;
      add(route, { status, body }, options);
    },
    fault(route, fault, options) {
      assertFault(fault);
      if (fault.kind !== "hold") {
        add(route, { fault }, options);
        return undefined;
      }
      const gate = createGate();
      add(route, { gate }, options);
      return { reached: gate.reached, release: gate.release };
    },
    /**
     * 接管了应答返回 true；没有脚本或 `hold` 放行之后返回 false，请求走正常路由。`denied` 是这个请求的鉴权失败
     * 应答，版本接口与鉴权通过时为 `undefined`。
     */
    async serve(method, path, response, denied) {
      const entry = find(method, path);
      if (entry === undefined) {
        return false;
      }
      if (entry.body !== undefined && denied !== undefined) {
        send(response, denied);
        return true;
      }
      entry.times -= 1;
      if (entry.gate !== undefined) {
        gates.add(entry.gate);
        entry.gate.arrived();
        await entry.gate.released;
        return false;
      }
      if (entry.fault !== undefined) {
        FAULTS[entry.fault.kind](response, entry.fault);
        return true;
      }
      send(response, { status: entry.status, json: entry.body });
      return true;
    },
    close() {
      for (const gate of gates) {
        gate.release();
      }
    },
  };
}
