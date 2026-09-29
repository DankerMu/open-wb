/**
 * fake-omp argv 解析（从 fake-omp.mjs 纯搬迁，#650）：取值型/布尔型 argv 表、位置无关的单遍解析与缺值判定、
 * 延迟类取值校验。只返回解析结果，不决定场景行为，不发帧，不持有模块级可变状态。
 */

/** 取值型 argv → parseArgs 结果字段。 */
const VALUE_ARGS = new Map([
  ["--scenario", "scenario"],
  ["--resume", "resume"],
  ["--session-dir", "sessionDir"],
  ["--approval-mode", "approvalMode"],
  ["--ready-delay-ms", "delay"],
  ["--start-delay-ms", "startDelay"],
  ["--thinking-repeat", "repeat"],
]);
/** 布尔 argv → parseArgs 结果字段（缺省 false）。 */
const FLAG_ARGS = new Map([
  ["--hold-after-thinking", "hold"],
  ["--compact-silent", "silent"],
]);
/** 缺值记 ""（按非法处理）的取值字段。 */
const STRICT_VALUES = new Set(["delay", "startDelay", "repeat"]);

/**
 * 单遍扫描：取值型参数一律吃掉紧随其后的 token（`argv[++i]`），无论它长什么样。
 * `--branch-entry` 同样吃掉下一 token 但按序累积（可重复）；位于末尾缺值时不追加。
 */
export function parseArgs(argv) {
  const parsed = { scenario: "normal", hold: false, silent: false, entries: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = VALUE_ARGS.get(argv[i]);
    if (key !== undefined) {
      parsed[key] = argv[++i] ?? missingValue(parsed, key);
    } else if (argv[i] === "--branch-entry") {
      const text = argv[++i];
      if (text !== undefined) {
        parsed.entries.push(text);
      }
    } else if (FLAG_ARGS.has(argv[i])) {
      parsed[FLAG_ARGS.get(argv[i])] = true;
    }
  }
  return parsed;
}

/** 缺值：--scenario 保留原值；延迟类与 --thinking-repeat 记 ""（按非法处理）；其余 undefined。 */
function missingValue(parsed, key) {
  if (key === "scenario") {
    return parsed.scenario;
  }
  return STRICT_VALUES.has(key) ? "" : undefined;
}

/**
 * 延迟毫秒数（`--ready-delay-ms`、`--start-delay-ms`）：缺省取 `fallback`；非负整数且 ≤ 2^31-1，
 * 否则抛错（顶层求值时抛出即退出 1 且零帧）。
 */
export function parseDelay(raw, flag, fallback) {
  if (raw === undefined) {
    return fallback;
  }
  if (/^\d+$/u.test(raw) && Number(raw) <= 2_147_483_647) {
    return Number(raw);
  }
  throw new Error(`invalid ${flag}: ${JSON.stringify(raw)}`);
}
