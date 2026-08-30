import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TRACKED_MIGRATIONS_DIRECTORY = fileURLToPath(new URL("./migrations/", import.meta.url));

export interface MigrationAsset {
  filename: string;
  source: string;
}

/** 读取固定、受信任的迁移目录；不接受任何运行时目录配置。 */
export function trackedMigrationAssets(): MigrationAsset[] {
  return readMigrationAssets(TRACKED_MIGRATIONS_DIRECTORY);
}

/** 内部测试接缝：只读取给定目录的直属普通 SQL 文件及其精确字节。 */
export function readMigrationAssets(directory: string): MigrationAsset[] {
  const trustedDirectory = trustedDirectoryPath(directory);
  const filenames = readdirSync(trustedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort(compareMigrationFilenames);

  return filenames.map((filename) => ({
    filename,
    source: readMigrationSourceFromTrustedDirectory(trustedDirectory, filename),
  }));
}

/** Unicode scalar-value 字典序；不依赖 UTF-16、locale 或自然排序。 */
export function compareMigrationFilenames(left: string, right: string): number {
  let leftOffset = 0;
  let rightOffset = 0;

  while (leftOffset < left.length && rightOffset < right.length) {
    const leftCodePoint = left.codePointAt(leftOffset);
    const rightCodePoint = right.codePointAt(rightOffset);

    if (leftCodePoint === undefined || rightCodePoint === undefined) {
      break;
    }
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint - rightCodePoint;
    }

    leftOffset += codePointWidth(leftCodePoint);
    rightOffset += codePointWidth(rightCodePoint);
  }

  if (leftOffset < left.length) {
    return 1;
  }
  if (rightOffset < right.length) {
    return -1;
  }
  return 0;
}

function trustedDirectoryPath(directory: string): string {
  return realpathSync(directory);
}

function readMigrationSourceFromTrustedDirectory(
  trustedDirectory: string,
  filename: string,
): string {
  const candidatePath = directChildPath(trustedDirectory, filename);
  const candidateStatus = lstatSync(candidatePath);

  if (!candidateStatus.isFile() || candidateStatus.isSymbolicLink()) {
    throw new Error(`migration source is not a regular direct child: ${filename}`);
  }

  const resolvedCandidate = realpathSync(candidatePath);
  if (dirname(resolvedCandidate) !== trustedDirectory || basename(resolvedCandidate) !== filename) {
    throw new Error(`migration source escapes its trusted directory: ${filename}`);
  }

  return readFileSync(candidatePath, "utf8");
}

function directChildPath(trustedDirectory: string, filename: string): string {
  if (filename.length === 0 || basename(filename) !== filename) {
    throw new Error(`migration filename is not a direct child: ${filename}`);
  }

  const candidatePath = resolve(trustedDirectory, filename);
  if (dirname(candidatePath) !== trustedDirectory) {
    throw new Error(`migration filename escapes its trusted directory: ${filename}`);
  }

  return candidatePath;
}

function codePointWidth(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}
