/** 拷入层：registry 原样拷入的两个目录（ui-foundation「组件分层」）。 */
export const COPIED_DIRS = ["web/src/components/ui", "web/src/components/assistant-ui"];

export const CHAT_DIR = "web/src/features/chat";

export type SourceFile = { path: string; text: string };

export const isUnder = (path: string, area: string) => path === area || path.startsWith(`${area}/`);
