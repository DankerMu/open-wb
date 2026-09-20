import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export function deriveProxyBaseUrl(address: AddressInfo): string {
  const host = hostOf(address.address);
  return `http://${host}:${address.port}/v1`;
}

export async function writeManagedModelsYml(
  agentDir: string,
  options: { proxyBaseUrl: string; modelId: string },
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const quotedUrl = JSON.stringify(options.proxyBaseUrl);
  const quotedModel = JSON.stringify(options.modelId);
  const yaml = [
    "providers:",
    "  workbuddy:",
    "    api: openai-completions",
    `    baseUrl: ${quotedUrl}`,
    "    apiKey: WORKBUDDY_MODEL_TOKEN",
    "    models:",
    `      - id: ${quotedModel}`,
    `        name: ${quotedModel}`,
    "        contextWindow: 128000",
    "        maxTokens: 8192",
    "",
  ].join("\n");
  await writeFile(join(agentDir, "models.yml"), yaml);
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
