/**
 * 托管 models.yml 在 S1g 多模型改动之前的两种单模型输出（issue #511 起的字节，issue #990 的「改动前夹具」）。
 * 只此一份：写出器测试与启动布局测试都拿它做逐字节比较。
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
