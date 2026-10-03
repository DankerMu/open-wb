/* Read-only project config entry of the session header (issue 816, design D4 of issue 773): the files of
   `GET /api/project-config` for the selected session's workspace, a header button that exists only
   while that list is non-empty and the dialog it opens. A list of files present at the locations
   the assistant reads, not of files in effect; no content is read and nothing can be edited. */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import type { ProjectConfigFile } from "../../lib/api-commands.js";
import type { ChatSession } from "../../lib/session-contract.js";
import { Dialog, Tag } from "../../ui/index.js";

const TITLE = "助手会读取的项目配置文件";
const NOTE = "以下位置存在配置文件；同一层有多个说明文件时只有一个生效";

const KIND_LABELS: Record<ProjectConfigFile["kind"], string> = {
  instructions: "说明",
  system: "系统提示",
  agent: "智能体",
};

/** The list of one selection: the call was made by `client` for this session and workspace id. */
type Held = {
  client: ApiClient;
  sessionId: string;
  workspaceId: string | null;
  files: ProjectConfigFile[];
};

type ConfigGroup = { depth: number; label: string; files: ProjectConfigFile[] };

/** The accessible name of the header button for a list of `count` files. */
function projectConfigLabel(count: number): string {
  return `项目配置 ${count}`;
}

/**
 * `files` grouped by `depth`, the groups in ascending depth and the files of a group in the order
 * received: `当前目录` for depth 0, `上 <n> 级目录` for the directory `n` levels above it.
 */
export function groupByDepth(files: readonly ProjectConfigFile[]): ConfigGroup[] {
  const groups = new Map<number, ConfigGroup>();
  for (const file of files) {
    const group = groups.get(file.depth) ?? {
      depth: file.depth,
      label: file.depth === 0 ? "当前目录" : `上 ${file.depth} 级目录`,
      files: [],
    };
    group.files.push(file);
    groups.set(file.depth, group);
  }
  return [...groups.values()].sort((left, right) => left.depth - right.depth);
}

/** The groups as headed lists; `path` comes from the workspace and is rendered as text only. */
function ConfigList({ files }: { files: readonly ProjectConfigFile[] }) {
  return (
    <div className="chat-project-config">
      {groupByDepth(files).map((group) => (
        <section aria-label={group.label} className="chat-project-config-group" key={group.depth}>
          <h3 className="chat-project-config-title">{group.label}</h3>
          <ul className="chat-project-config-list">
            {group.files.map((file) => (
              <li className="chat-project-config-item" key={file.path}>
                <span className="chat-project-config-path">{file.path}</span>
                <Tag>{KIND_LABELS[file.kind]}</Tag>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The project config entry of the session page. `selected` is the session the top bar shows,
 * undefined in the welcome state and while a requested session is not resolved: nothing is asked
 * then. One `listProjectConfig(workspaceId)` call is issued per client, session id and workspace
 * id; the call of a previous selection is aborted. `slot` is the top-bar slot, present only while
 * the list held was answered for exactly the current selection and is non-empty: a pending call, a
 * failed one (silent, no retry until the selection changes) and an empty list yield no button, and
 * the list of another session is never shown. `dialog` is the read-only list, closed with its
 * session and still closed when that session is selected again; closing hands the focus back to
 * the header button.
 */
export function useProjectConfig(
  client: ApiClient,
  selected: ChatSession | undefined,
): {
  slot: { label: string; expanded: boolean; onSelect(trigger: HTMLElement): void } | undefined;
  dialog: ReactNode;
} {
  const sessionId = selected?.id;
  const workspaceId = selected?.workspaceId ?? null;
  const [held, setHeld] = useState<Held | null>(null);
  /**
   * The answer whose dialog is open. An answer, not a session id: the dialog of a session that was
   * left unmounts without a close event, and the next answer for that session is another object.
   */
  const [opened, setOpened] = useState<Held | null>(null);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (sessionId === undefined) return;
    const controller = new AbortController();
    void client.listProjectConfig(workspaceId, { signal: controller.signal }).then(
      (files) => {
        if (!controller.signal.aborted) setHeld({ client, sessionId, workspaceId, files });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [client, sessionId, workspaceId]);

  if (
    held === null ||
    held.client !== client ||
    held.sessionId !== sessionId ||
    held.workspaceId !== workspaceId ||
    held.files.length === 0
  ) {
    return { slot: undefined, dialog: null };
  }
  const { files } = held;

  const open = opened === held;
  return {
    slot: {
      label: projectConfigLabel(files.length),
      expanded: open,
      onSelect(button) {
        trigger.current = button;
        setOpened(held);
      },
    },
    dialog: (
      <Dialog
        description={NOTE}
        onOpenChange={(next) => {
          if (!next) setOpened(null);
        }}
        open={open}
        returnFocus={trigger}
        size="sm"
        title={TITLE}
      >
        <ConfigList files={files} />
      </Dialog>
    ),
  };
}
