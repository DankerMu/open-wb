import type { AddressInfo } from "node:net";
import { replaceFile } from "../core/replace-file.js";
import type { CatalogModel } from "../model-catalog.js";

export function deriveProxyBaseUrl(address: AddressInfo): string {
  const host = hostOf(address.address);
  return `http://${host}:${address.port}/v1`;
}

/**
 * `agentDir` must exist: the managed omp state layout creates it, this writer never does.
 * One entry per whitelist model, in order. An empty whitelist is refused before the file is touched.
 */
export async function writeManagedModelsYml(
  agentDir: string,
  options: { proxyBaseUrl: string; models: readonly CatalogModel[] },
): Promise<void> {
  if (options.models.length === 0) {
    throw new Error("managed models.yml needs at least one model");
  }
  const yaml = [
    "providers:",
    "  workbuddy:",
    "    api: openai-completions",
    `    baseUrl: ${JSON.stringify(options.proxyBaseUrl)}`,
    "    apiKey: WORKBUDDY_MODEL_TOKEN",
    "    models:",
    ...options.models.flatMap(modelLines),
    "",
  ].join("\n");
  await replaceFile(agentDir, "models.yml", yaml);
}

/** Key order is read by omp: limits, the reasoning pair, `thinking`, then `input`. */
function modelLines(model: CatalogModel): string[] {
  return [
    `      - id: ${JSON.stringify(model.id)}`,
    `        name: ${JSON.stringify(model.name)}`,
    "        contextWindow: 128000",
    "        maxTokens: 8192",
    ...(model.reasoning
      ? [
          "        reasoning: true",
          "        compat:",
          "          reasoningContentField: reasoning_content",
        ]
      : []),
    // Only a MODEL_CATALOG reasoning model carries efforts; without them omp derives its own set.
    ...(model.efforts === undefined
      ? []
      : [
          "        thinking:",
          "          mode: effort",
          "          efforts:",
          ...model.efforts.map((effort) => `            - ${JSON.stringify(effort)}`),
        ]),
    ...(model.vision ? ["        input:", "          - text", "          - image"] : []),
  ];
}

function hostOf(address: string): string {
  if (address === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (address === "::") {
    return "[::1]";
  }
  if (address.includes(":")) {
    return `[${address}]`;
  }
  return address;
}
