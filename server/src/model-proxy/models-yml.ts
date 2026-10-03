import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ensureSharedDir } from "../core/sandbox/dirs.js";

export function deriveProxyBaseUrl(address: AddressInfo): string {
  const host = hostOf(address.address);
  return `http://${host}:${address.port}/v1`;
}

export async function writeManagedModelsYml(
  agentDir: string,
  options: { proxyBaseUrl: string; modelId: string; reasoning?: boolean },
): Promise<void> {
  ensureSharedDir(agentDir);
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
    ...(options.reasoning === true
      ? [
          "        reasoning: true",
          "        compat:",
          "          reasoningContentField: reasoning_content",
        ]
      : []),
    "",
  ].join("\n");
  await replaceFile(agentDir, "models.yml", yaml);
}

/**
 * Replaces `<dir>/<name>` without ever opening that path: the omp uid can write the agent dir
 * (ADR-0010), so a symlink planted there must be replaced, not written through. The content goes
 * to a temporary file created exclusively in `dir`, with mode 0640 whatever the umask, which is
 * then renamed over the target. A failure after the creation removes the temporary file.
 */
async function replaceFile(dir: string, name: string, content: string): Promise<void> {
  const temporary = join(dir, `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.chmod(0o640);
    } finally {
      await handle.close();
    }
    await rename(temporary, join(dir, name));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
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
