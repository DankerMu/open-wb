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
 *
 * Round 1 补充（sticky failure state-transition）：
 * 真实失败判定（owned.failed = true; process.exitCode = 1;）必须先于失败路径的第一次
 * yield（releaseOwned / emitStartupFailed 的 await 位）——失败判定不得被 signalReceived
 * 门控，generic 发布不得被 signalReceived 跳过；requestShutdown 的退出码赋值必须把
 * 已判定失败/release 失败视为 sticky，不得无条件覆写为 0。
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

describe("server.ts sticky failure：失败判定先于 yield，且不被 signal 压制", () => {
  it("catch 内 failed=true 与 exitCode=1 的判定先于失败路径第一次 await/yield", () => {
    // 判定必须先于任何 yield：releaseOwned/emitStartupFailed 的 await 位都在判定之后。
    const failedAssign = source.indexOf("owned.failed = true;");
    const exitCodeOne = source.indexOf("process.exitCode = 1;", failedAssign);
    const releaseAwait = source.indexOf("await releaseOwned(owned);", failedAssign);
    const emitAwait = source.indexOf("await emitStartupFailed();", failedAssign);

    expect(failedAssign).toBeGreaterThan(-1);
    expect(exitCodeOne).toBeGreaterThan(failedAssign);
    expect(releaseAwait).toBeGreaterThan(exitCodeOne);
    expect(emitAwait).toBeGreaterThan(exitCodeOne);
  });

  it("catch 内没有 signalReceived 门控：失败判定与 generic 发布无条件执行", () => {
    // 从 failed=true 判定位到 emitStartupFailed 调用位之间不得出现 signalReceived 条件分支。
    const failedAssign = source.indexOf("owned.failed = true;");
    const emitCatchCall = source.indexOf("await emitStartupFailed();", failedAssign);
    expect(failedAssign).toBeGreaterThan(-1);
    expect(emitCatchCall).toBeGreaterThan(failedAssign);

    const between = source.slice(failedAssign, emitCatchCall);
    expect(between).not.toContain("signalReceived");
  });

  it("requestShutdown 退出码赋值把已判定失败视为 sticky，不降 0", () => {
    const shutdownAssign = source.indexOf(
      "process.exitCode = owned.releaseFailed || owned.failed ? 1 : 0;",
    );
    expect(shutdownAssign).toBeGreaterThan(-1);
    // 不得出现无条件覆写为 0 / 仅依赖 releaseFailed 的旧形态。
    expect(source).not.toMatch(/process\.exitCode\s*=\s*owned\.releaseFailed\s*\?\s*1\s*:\s*0\s*;/);
    expect(source).not.toMatch(/process\.exitCode\s*=\s*0\s*;/);
  });

  it("失败判定字段存在于 OwnedResources 且初始为 false", () => {
    expect(source).toContain("failed: boolean;");
    expect(source).toContain("failed: false,");
  });
});
