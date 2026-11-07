/** 只解析以 `\n` 结束的行；末尾未结束的半行丢弃，已结束的坏行抛错；文件不存在时返回 `[]`。 */
export function readCompleteJsonl<T = unknown>(file: string): T[];
