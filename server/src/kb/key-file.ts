/**
 * 启动阶段 `kb_key` 的读取与校验（s2a-kb-ragflow D3，ragflow-backend「知识库配置与密钥文件」）。
 *
 * 打开时不跟随末段符号链接、不等 FIFO 的写端；此后属主、权限位、大小与内容都以描述符为准，路径之后变成什么
 * 不影响结果（钩子辅助复现，`server-startup-kb.test.ts`）。写法同 `workspaces/regular-file.ts`，不复用它：
 * `kb → workspaces` 的依赖到组 10 才声明（system.md §4 规则 2），且它把失败映射成 HTTP `not_found`。
 *
 * 错误只点名键：原生错误带路径，一律丢弃，不放进 `cause`。入口丢弃这里的 message，失败记录只有 `reason`。
 *
 * 属主比 euid（同 `core/sandbox/dirs.ts`）：文件权限判定用的就是它。拿不到 uid 的平台按不合规处理。
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { assertHeaderSafeKey } from "../agent-config.js";

const KEY_FILE_SETTING = "RAGFLOW_API_KEY_FILE";
const INVALID_KEY_FILE = `${KEY_FILE_SETTING} must be a private regular file holding one API key`;
const MAX_KEY_FILE_BYTES = 4096;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** 读出的密钥只在这个闭包里：序列化与 inspect 看不到它，对象本身冻结。 */
export interface KbKeyHandle {
  read(): string;
}

/** `getuid` 是属主判定的缝：非特权进程造不出别的属主。 */
export function readKbKeyFile(
  path: string,
  seams: { getuid: () => number | undefined } = { getuid: () => process.geteuid?.() },
): KbKeyHandle {
  const content = readPrivateFile(path, seams.getuid());
  const key = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (key === "") {
    throw new Error(INVALID_KEY_FILE);
  }
  assertHeaderSafeKey(key, KEY_FILE_SETTING);
  return Object.freeze({ read: () => key });
}

function readPrivateFile(path: string, uid: number | undefined): string {
  try {
    const fd = openSync(path, OPEN_FLAGS);
    try {
      if (!isPrivateKeyFile(fstatSync(fd), uid)) {
        throw new Error(INVALID_KEY_FILE);
      }
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error(INVALID_KEY_FILE);
  }
}

function isPrivateKeyFile(status: Stats, uid: number | undefined): boolean {
  return (
    status.isFile() &&
    status.uid === uid &&
    (status.mode & 0o077) === 0 &&
    status.size >= 1 &&
    status.size <= MAX_KEY_FILE_BYTES
  );
}
