import { readFileSync } from "node:fs";

/**
 * 托管 models.yml 在 S1g 多模型改动之前的两种单模型输出（issue #511 起的字节，issue #990 的「改动前夹具」）。
 * #1563 起写出器不再产出这两种字节；它们只作「Single-model output is unchanged」的行序列比对基准
 *（经 `withMaxTokens` 换掉上限一行）。现行字节见同目录的两个 #1563 基线文件与 `baselineYaml`。
 */

/** reasoning 为假的输出（10 行 + 结尾换行）。 */
export function plainYaml(baseUrl: string, modelId: string): string {
  return [
    "providers:",
    "  workbuddy:",
    "    api: openai-completions",
    `    baseUrl: "${baseUrl}"`,
    "    apiKey: WORKBUDDY_MODEL_TOKEN",
    "    models:",
    `      - id: "${modelId}"`,
    `        name: "${modelId}"`,
    "        contextWindow: 128000",
    "        maxTokens: 8192",
    "",
  ].join("\n");
}

/** reasoning 为真、不带 efforts 的输出（13 行 + 结尾换行）。 */
export function reasoningYaml(baseUrl: string, modelId: string): string {
  return [
    "providers:",
    "  workbuddy:",
    "    api: openai-completions",
    `    baseUrl: "${baseUrl}"`,
    "    apiKey: WORKBUDDY_MODEL_TOKEN",
    "    models:",
    `      - id: "${modelId}"`,
    `        name: "${modelId}"`,
    "        contextWindow: 128000",
    "        maxTokens: 8192",
    "        reasoning: true",
    "        compat:",
    "          reasoningContentField: reasoning_content",
    "",
  ].join("\n");
}

/**
 * model-proxy「Single-model output is unchanged」：改前夹具里唯一的 `maxTokens: 8192` 行换成所给的值
 *（夹具本身不动）。夹具里这一行不是恰好一处即抛出。
 */
export function withMaxTokens(fixture: string, maxTokens: number): string {
  const line = "        maxTokens: 8192\n";
  if (fixture.split(line).length !== 2) {
    throw new Error("the pre-change fixture must hold exactly one maxTokens line");
  }
  return fixture.replace(line, `        maxTokens: ${String(maxTokens)}\n`);
}

/** #1563 基线文件里的端点与模型 id；`baselineYaml` 把这三行换成所给的值。 */
const BASELINE_BASE_URL = "http://127.0.0.1:18016/v1";
const BASELINE_MODEL_ID = "deepseek-v4.1-flash";

/**
 * model-proxy「Single-model output is unchanged」（#1563）：未设置 MODEL_CATALOG、MODEL_VISION=off 的
 * 单模型输出，取自同目录的基线文件 `models-yml-reasoning-{true,false}.yml`（端点 18016、模型
 * `deepseek-v4.1-flash`、`maxTokens: 32768`），只把 baseUrl、id、name 三行换成所给的值（每行恰一处，否则抛出）。
 */
export function baselineYaml(reasoning: boolean, baseUrl: string, modelId: string): string {
  const file = new URL(`./models-yml-reasoning-${String(reasoning)}.yml`, import.meta.url);
  let text = readFileSync(file, "utf8");
  for (const [prefix, from, to] of [
    ["    baseUrl: ", BASELINE_BASE_URL, baseUrl],
    ["      - id: ", BASELINE_MODEL_ID, modelId],
    ["        name: ", BASELINE_MODEL_ID, modelId],
  ] as const) {
    const parts = text.split(`\n${prefix}"${from}"\n`);
    if (parts.length !== 2) {
      throw new Error(`the baseline fixture must hold exactly one ${prefix.trim()} line`);
    }
    text = parts.join(`\n${prefix}"${to}"\n`);
  }
  return text;
}

/**
 * model-proxy「Single-model default declares image input」（#1530、#1563）：vision 为真的单模型输出是
 * vision 为假的输出在 `input` 列表末尾恰多一行 `- image`，其余行不变。只接受单模型输出（以换行结尾）。
 */
export function withVisionInput(singleModelYaml: string): string {
  if (!singleModelYaml.endsWith("\n")) {
    throw new Error("the single-model output must end with a newline");
  }
  return `${singleModelYaml}          - image\n`;
}
