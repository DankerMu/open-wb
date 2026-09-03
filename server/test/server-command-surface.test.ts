import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 命令面 PID signal 契约（Issue #7 / Round 1 P1 contract）：
 * `npm run start --workspace server` 与 `make dev` 必须收敛到同一个前台 Node owner，
 * 使只对 wrapper PID 发送的 SIGINT/SIGTERM 也能到达 Node——npm 11 的 signal-manager
 * 只向直接子进程转发信号，因此 `&&` 之后的最终段必须用 `exec` 替换 shell 自身；
 * `make dev` 必须保持单一直接转发边（同一 workspace start owner）。
 * 机械 source 判别：删除 `exec` 的 mutant 必须使断言变红。
 */

const PACKAGE_PATH = new URL("../package.json", import.meta.url);
const serverPackage = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as {
  scripts?: Record<string, string>;
};
const makefile = readFileSync(new URL("../../Makefile", import.meta.url), "utf8");

const START_SCRIPT = serverPackage.scripts?.start;

describe("命令面：start 以 exec 替换 shell，单一 Node owner 承接 PID-only signal", () => {
  it("server workspace 的 start 恰为 build 后 exec 最终段", () => {
    expect(START_SCRIPT).toBe("npm run build && exec node dist/server.js");
  });

  it("根 Makefile 的 dev 保持单一直接转发边（同一 workspace start owner）", () => {
    const lines = makefile.split("\n");
    const targetIndex = lines.findIndex((line) => line.startsWith("dev:"));
    expect(targetIndex).toBeGreaterThan(-1);
    // 目标下第一条以 tab 开头的行就是其 recipe——必须恰为 workspace start 转发。
    const recipe = lines.slice(targetIndex + 1).find((line) => /^\t/u.test(line));
    expect(recipe).toBeDefined();
    expect(recipe?.trim()).toBe("npm run start --workspace server");
    // 不得在 make 层形成第二套启动逻辑（不得另有 node/spawn/exec/uv 分支目标）。
    const devSection = makefile.slice(makefile.indexOf("dev:"), makefile.indexOf("precommit:"));
    expect(devSection).not.toMatch(/node |spawn|exec |uv /u);
  });

  it("除 start 外的任何 lifecycle script 均不得 launch 生产入口 dist/server.js", () => {
    const scripts = serverPackage.scripts ?? {};
    expect(Object.keys(scripts).length).toBeGreaterThan(0);
    // 只拒绝生产入口 launch（如 `prestart: node dist/server.js` 或 build 尾部追加
    // `node dist/server.js`）；build 内合法的 `node scripts/copy-migration-assets.mjs` 不受影响。
    const siblingLaunchers = Object.entries(scripts).filter(
      ([name, command]) => name !== "start" && /\bnode\s+[^&|;]*dist\/server\.js/u.test(command),
    );
    expect(siblingLaunchers).toEqual([]);
  });
});
