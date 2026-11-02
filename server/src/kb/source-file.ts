/**
 * 工作空间来源的读取（s2a-kb-ragflow D10 的第 1、4 步，D12）：入库与重新入库经这里解析、打开源文件，文档列表经这里 stat。
 * 读取链路同 `workspaces/rest-archive.ts`，都从 `workspaces` 入口导入：
 *
 * - `resolve`：`sandbox.resolve(principal, workspaceId, path, "read")`。越界由 facade 写 `sandbox.reject`，这里只译成
 *   `outside`。路径上任一分量是符号链接时 facade 也拒绝，同样归 `outside`。
 * - `open`：挂载内经挂载读取（`mountToRead` 在 `resolve` 之后，只读挂载照样放行），挂载外以 `O_NOFOLLOW` 打开。先 lstat
 *   再打开：目录与 FIFO 不被打开。大小与修改时间都来自对同一 fd 的 `fstat`。
 * - `stat`：组 11 的 `sourceChanged`。不经 facade，读不到不写审计：列表每 3 秒刷新一次，源路径被换成符号链接时不能每次
 *   写一条 `sandbox.reject`。挂载名照传，否则纯函数 `resolve` 会同步 lstat 挂载点。
 *
 * 读取的流一路读到 EOF，不按 `size` 截断：文件长大了要读得出来，字节数由 `kb/multipart.ts` 核对。流销毁即还 fd。
 *
 * 一条路径读不了不能毁掉整批（knowledge-bases：请求合法且本地写入没有失败即 201）：打开失败除离线外都归 `not_file`，含 EACCES。
 */
import { closeSync, createReadStream, fstatSync } from "node:fs";
import { Readable } from "node:stream";
import { HttpError } from "../core/errors/index.js";
import type { createSandbox } from "../core/sandbox/index.js";
import { resolve as resolveInRoot } from "../core/sandbox/resolve.js";
import {
  closeMountFile,
  isOrdinaryDirectory,
  isStructuralAbsence,
  lstatExisting,
  type MountFile,
  type MountManager,
  mountToRead,
  openMountFile,
  openRegularFile,
  ownedRootOf,
  readMountAt,
  requireMountFile,
  type WorkspaceStore,
} from "../workspaces/index.js";

/** 一次读挂载的字节数，同 `mounts/files.ts`。 */
const CHUNK_BYTES = 64 * 1024;

interface Principal {
  id: string;
}

interface SourceFilesDependencies {
  workspaces: {
    store: Pick<WorkspaceStore, "rootOf">;
    sandbox: ReturnType<typeof createSandbox>;
  };
  mounts: Pick<MountManager, "mountOf" | "fs">;
  /** 测试缝：`fstat` 之后、读取之前调用，用例在这里改写文件（`KbDependencies.onSourceStat`）。 */
  onStat?: ((absPath: string) => void) | undefined;
}

/** 读取被拒的原因，取值同 `kb.ingest_reject` 的 `reason`。 */
type SourceRejection = { reason: "outside" | "not_file" | "offline" };

/** 打开的源文件：调用方要么取 `stream()` 读完或销毁，要么 `close()`，只做一个。 */
export interface OpenedSource {
  size: number;
  mtimeMs: number;
  stream(): Readable;
  close(): void;
}

/** `stat` 的结果：`absent` 是确知已不在；`null` 是不知道（解析被拒、不可见、离线）。 */
type SourceStat = { size: number; mtimeMs: number } | "absent" | null;

export const isMountOffline = (error: unknown): boolean =>
  error instanceof HttpError && error.code === "mount_offline";

function openLocal(absPath: string): OpenedSource {
  if (lstatExisting(absPath)?.isFile() !== true) {
    throw new HttpError("not_found");
  }
  const { fd } = openRegularFile(absPath);
  try {
    const { size, mtimeMs } = fstatSync(fd);
    return {
      size,
      mtimeMs,
      stream: () => createReadStream("", { fd, autoClose: true }),
      close: () => {
        closeSync(fd);
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function mountStream(fs: MountManager["fs"], file: MountFile): Readable {
  async function* chunks() {
    let position = 0;
    for (;;) {
      const chunk = await readMountAt(fs, file, position, CHUNK_BYTES);
      if (chunk.length === 0) {
        return;
      }
      position += chunk.length;
      yield chunk;
    }
  }
  const stream = Readable.from(chunks(), { objectMode: false });
  stream.once("close", () => {
    void closeMountFile(fs, file);
  });
  return stream;
}

async function openInMount(
  fs: MountManager["fs"],
  mountId: string,
  absPath: string,
): Promise<OpenedSource> {
  await requireMountFile(fs, mountId, absPath);
  const file = await openMountFile(fs, mountId, absPath);
  try {
    const { size, mtimeMs } = await fs.fstat(mountId, file.handle);
    return {
      size,
      mtimeMs,
      stream: () => mountStream(fs, file),
      close: () => {
        void closeMountFile(fs, file);
      },
    };
  } catch (error) {
    void closeMountFile(fs, file);
    throw error;
  }
}

export function createSourceFiles(dependencies: SourceFilesDependencies) {
  const { workspaces, mounts, onStat } = dependencies;
  const { store, sandbox } = workspaces;

  /** 工作空间可见时的根，否则 404：别人的、已删除的、根被占据或不在了，同文件路由。 */
  function visibleRoot(principal: Principal, workspaceId: string): string {
    const root = ownedRootOf(store, principal, workspaceId);
    if (root === null || !isOrdinaryDirectory(root)) {
      throw new HttpError("not_found");
    }
    return root;
  }

  async function lstatSource(workspaceId: string, path: string, absPath: string) {
    const mount = mountToRead((name) => mounts.mountOf(workspaceId, name), path);
    if (mount === undefined) {
      return lstatExisting(absPath);
    }
    try {
      return await mounts.fs.lstat(mount.id, absPath);
    } catch (error) {
      if (isStructuralAbsence(error)) {
        return undefined;
      }
      throw error;
    }
  }

  return {
    /** `workspaceId` 不可见时 404（knowledge-bases：整个请求）。 */
    assertVisible(principal: Principal, workspaceId: string): void {
      visibleRoot(principal, workspaceId);
    },

    /** 第 1 步。排队期间工作空间没了：不是越界，文件也已不在。 */
    resolve(
      principal: Principal,
      workspaceId: string,
      path: string,
    ): { absPath: string } | SourceRejection {
      try {
        return { absPath: sandbox.resolve(principal, workspaceId, path, "read") };
      } catch (error) {
        const outside = error instanceof HttpError && error.code === "sandbox_denied";
        return { reason: outside ? "outside" : "not_file" };
      }
    },

    /** 第 4 步。`path` 是请求里的相对路径，判定挂载成员用。 */
    async open(
      workspaceId: string,
      path: string,
      absPath: string,
    ): Promise<OpenedSource | SourceRejection> {
      try {
        const mount = mountToRead((name) => mounts.mountOf(workspaceId, name), path);
        const opened =
          mount === undefined
            ? openLocal(absPath)
            : await openInMount(mounts.fs, mount.id, absPath);
        onStat?.(absPath);
        return opened;
      } catch (error) {
        return { reason: isMountOffline(error) ? "offline" : "not_file" };
      }
    },

    /** 无审计，见文件头。不是普通文件算 `absent`：记录的那个文件已不在这里。读不到就是不知道，不抛错。 */
    async stat(principal: Principal, workspaceId: string, path: string): Promise<SourceStat> {
      try {
        const root = visibleRoot(principal, workspaceId);
        const resolved = resolveInRoot(root, path, "read", sandbox.mountNamesOf(workspaceId));
        if (!resolved.ok) {
          return null;
        }
        const stats = await lstatSource(workspaceId, path, resolved.absPath);
        return stats?.isFile() === true ? { size: stats.size, mtimeMs: stats.mtimeMs } : "absent";
      } catch {
        return null;
      }
    },
  };
}
