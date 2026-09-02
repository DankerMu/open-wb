import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 启动顺序契约（Issue #7 / Phase 2 P1 state-transition）：
 * main 路径必须先把完整 env 配置解析/校验成功，再安装 SIGINT/SIGTERM handler；
 * 配置失败时不得有任何 signal-registration / filesystem / DB / listen 副作用。
 * 该契约无法在无监听单测边界内于子进程全局状态上观察，因此用机械 source-order
 * discriminator 锁定顺序：resolveServerConfig(process.env) 必须先于两个 process.on，
 * 且 process.env 只被消费一次（不得二次解析）。
 */

const SOURCE_PATH = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const source = readFileSync(SOURCE_PATH, "utf8");

describe("server.ts 启动顺序：配置先于 signal 注册", () => {
  it("配置解析调用先于 SIGINT/SIGTERM 注册", () => {
    const configCall = source.indexOf("resolveServerConfig(process.env, entryUrl)");
    const sigint = source.indexOf('process.on("SIGINT"');
    const sigterm = source.indexOf('process.on("SIGTERM"');

    expect(configCall).toBeGreaterThan(-1);
    expect(sigint).toBeGreaterThan(-1);
    expect(sigterm).toBeGreaterThan(-1);
    expect(sigint).toBeGreaterThan(configCall);
    expect(sigterm).toBeGreaterThan(configCall);
  });

  it("process.env 只被配置 seam 消费一次（不二次解析）", () => {
    expect(source.match(/process\.env/g)).toHaveLength(1);
    expect(source.match(/resolveServerConfig\(process\.env/g)).toHaveLength(1);
  });

  it("失败路径的失败记录调用（调用位，非声明）先于第一个 handler 安装", () => {
    // "emitStartupFailed();" 只匹配调用位；"function emitStartupFailed()" 声明用无分号形式，不会误匹配。
    const emitFailCall = source.indexOf("emitStartupFailed();");
    const firstHandler = source.indexOf('process.on("SIGINT"');

    expect(emitFailCall).toBeGreaterThan(-1);
    expect(emitFailCall).toBeLessThan(firstHandler);
  });
});
