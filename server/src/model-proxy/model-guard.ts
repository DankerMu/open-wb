/**
 * 模型代理白名单的判定（model-proxy「透传端点与 bearer 鉴权」的 Model whitelist；design D18）。
 * 纯函数：不依赖 Fastify，不读环境。
 *
 * 为什么不能只看 `JSON.parse` 的结果：body 按原字节转发，而 `{"model":"a","model":"b"}` 在不同解析器下
 * 取到的值不同——只校验解析结果，上游就可能读到另一个模型。所以这里在原文上数顶层成员里键名等于
 * `model` 的个数，多于一个即拒绝。
 *
 * 前提：`raw` 已通过 `JSON.parse`，是良构 JSON。扫描器只据此跳过记号，不再校验语法；
 * 良构文本里字符串之外只会出现四种空白与结构字符，所以下面没有针对畸形输入的分支。
 */

/**
 * 顶层 `model` 的四种结果。
 * - `not-object`：顶层值不是对象（数组、字符串、数字、字面量）。
 * - `no-model`：顶层对象里没有解码后键名等于 `model` 的成员。
 * - `duplicate`：有两个或更多这样的成员（不论各自的值）。
 * - `unique`：恰有一个；`valueText` 是它的值在 `raw` 里的原文——恰好是那个值的记号，不含两侧空白，
 *   转义保持原样，`JSON.parse(valueText)` 即该值。
 */
type TopLevelModel =
  | { kind: "not-object" }
  | { kind: "no-model" }
  | { kind: "duplicate" }
  | { kind: "unique"; valueText: string };

const QUOTE = '"';

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipWhitespace(raw: string, from: number): number {
  let index = from;
  while (isWhitespace(raw[index])) {
    index += 1;
  }
  return index;
}

/**
 * `raw[start]` 是开引号；返回闭引号之后的下标。
 * 反斜杠连同它后面的一个字符一起跳过：`\"` 不结束字符串，`\\"` 里第二个反斜杠被第一个吃掉、引号结束字符串。
 */
function stringEnd(raw: string, start: number): number {
  let index = start + 1;
  while (index < raw.length && raw[index] !== QUOTE) {
    index += raw[index] === "\\" ? 2 : 1;
  }
  return index + 1;
}

/** `raw[start]` 是 `{` 或 `[`；返回与之配对的闭括号之后的下标。字符串整段跳过，其中的括号不计深度。 */
function containerEnd(raw: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < raw.length) {
    const char = raw[index];
    if (char === QUOTE) {
      index = stringEnd(raw, index);
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
    index += 1;
    if (depth === 0) {
      break;
    }
  }
  return index;
}

/** 顶层成员的数字或 `true` / `false` / `null` 值：到空白、逗号或对象的闭花括号为止（数组里的标量由 `containerEnd` 走过，不经这里）。 */
function scalarEnd(raw: string, start: number): number {
  let index = start;
  while (
    index < raw.length &&
    !isWhitespace(raw[index]) &&
    raw[index] !== "," &&
    raw[index] !== "}"
  ) {
    index += 1;
  }
  return index;
}

/** `raw[start]` 是一个值的第一个字符；返回该值之后的下标。 */
function valueEnd(raw: string, start: number): number {
  const char = raw[start];
  if (char === QUOTE) {
    return stringEnd(raw, start);
  }
  return char === "{" || char === "[" ? containerEnd(raw, start) : scalarEnd(raw, start);
}

/**
 * 扫描一段已通过 `JSON.parse` 的文本，只看顶层对象的成员键。
 * 键名按 JSON 字符串解码后再比较（`"mod\u0065l"` 也算 `model`）；嵌套层里的 `model` 不看。
 */
export function topLevelModel(raw: string): TopLevelModel {
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== "{") {
    return { kind: "not-object" };
  }
  let count = 0;
  let valueText = "";
  index = skipWhitespace(raw, index + 1);
  while (index < raw.length && raw[index] !== "}") {
    const keyEnd = stringEnd(raw, index);
    const key: unknown = JSON.parse(raw.slice(index, keyEnd));
    // 键之后是可选空白、冒号、可选空白。
    const valueStart = skipWhitespace(raw, skipWhitespace(raw, keyEnd) + 1);
    const end = valueEnd(raw, valueStart);
    if (key === "model") {
      count += 1;
      valueText = raw.slice(valueStart, end);
    }
    // 值之后是可选空白，然后是逗号（还有下一个成员）或闭花括号。
    index = skipWhitespace(raw, end);
    if (raw[index] === ",") {
      index = skipWhitespace(raw, index + 1);
    }
  }
  if (count === 0) {
    return { kind: "no-model" };
  }
  return count === 1 ? { kind: "unique", valueText } : { kind: "duplicate" };
}

/**
 * 请求体是否放行：`parsed` 是 `JSON.parse(raw)` 的结果。
 * 仅当顶层是对象、恰有一个顶层 `model` 成员、其值是字符串且逐码元等于 `allowed` 的某个元素时为 true。
 * 判定以原文扫描为准，不读 `parsed.model`。
 */
export function isAllowedModel(
  parsed: unknown,
  raw: string,
  allowed: ReadonlySet<string>,
): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const found = topLevelModel(raw);
  if (found.kind !== "unique") {
    return false;
  }
  const model: unknown = JSON.parse(found.valueText);
  return typeof model === "string" && allowed.has(model);
}
