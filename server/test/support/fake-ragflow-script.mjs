/**
 * 假 RAGFlow 的脚本层（`fake-ragflow.mjs` 的兄弟文件，design D17）：用例按路由接管应答。
 *
 * - `answer()`：协议应答，`code` 只收实测记录里出现过的值。
 * - `fault()`：故障注入，种类是闭集，只限 tasks.md 头部的四种：传输层（`hang`、`hold`、`reset`、`cut`、`stall`）、
 *   HTTP 层（`redirect`、`status`、`not_json`、`oversize`）、漂移值（`version`）、防御性组合（`combo`）。
 *
 * 一条脚本缺省生效一次，先登记的先生效，用完恢复正常。`hold` 放行后请求走正常路由。
 */
export const JSON_TYPE = "application/json; charset=utf-8";

/** 记录里出现过的 body code（§3–§12）。 */
const RECORDED_CODES = new Set([0, 100, 101, 102, 103, 400, 401, 403, 404, 409, 500, 501]);
/** tasks.md 头部的防御性组合。 */
const COMBO_CODES = new Set([100, 101, 102, 403]);

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

function partial(response, fault) {
  response.writeHead(200, { "content-type": JSON_TYPE, ...fault.headers });
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

function assertFault(fault) {
  if (fault.kind !== "hold" && !Object.hasOwn(FAULTS, fault.kind)) {
    throw new Error(`fake-ragflow has no fault kind ${String(fault.kind)}`);
  }
  if (fault.kind === "combo" && fault.deletedList !== true && !COMBO_CODES.has(fault.code)) {
    throw new Error(`fake-ragflow combo takes 100, 101, 102 or 403, not ${String(fault.code)}`);
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

  function take(method, path) {
    const entry = entries.find(
      (candidate) =>
        candidate.method === method && candidate.pattern.test(path) && candidate.times > 0,
    );
    if (entry !== undefined) {
      entry.times -= 1;
    }
    return entry;
  }

  return {
    answer(route, reply, options) {
      if (!RECORDED_CODES.has(reply.code)) {
        throw new Error(`code ${String(reply.code)} is not in the rc2 record`);
      }
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
    /** 接管了应答返回 true；没有脚本或 `hold` 放行之后返回 false，请求走正常路由。 */
    async serve(method, path, response) {
      const entry = take(method, path);
      if (entry === undefined) {
        return false;
      }
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
