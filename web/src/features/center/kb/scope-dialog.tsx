import { useCallback, useId, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ApiClient, BaseView, KbScopeInput, MyScope } from "@/lib/api";
import { DialogActions, DialogAlert, KbDialog } from "./dialog-shell.js";
import { MUTED, messageOf } from "./ingest-tree.js";

// 可见范围的控件与范围对话框（s2c-kb-visibility D9；knowledge-bases「中心「知识库」tab」范围对话框与新建对话框的
// 可见范围）。四档文案只在 `SCOPES`：列表与详情的范围标签也从这里取名。

type Scope = BaseView["scope"]["scope"];

/** 四档的名称与说明，逐字取 demo :2738-2741。 */
export const SCOPES: readonly { value: Scope; label: string; description: string }[] = [
  { value: "me", label: "仅自己可见", description: "只有你能检索与引用，文档留在你的沙箱内" },
  { value: "dept", label: "本部门可见", description: "同部门同事可检索与引用，但不能改动内容" },
  { value: "group", label: "项目组可见", description: "指定项目组的成员可检索与引用，可跨部门" },
  { value: "all", label: "全员可见", description: "全公司可检索与引用，适合口径、规范类文档" },
];

const NO_DEPT = "你的账号没有部门信息";
const NO_GROUP = "你还不属于任何项目组，请让管理员在「中心 → 账号」中把你加入";
const AUDIT_HINT = "共享只给读权限：他人可检索与引用，不能增删文档或改设置。切换范围会记入审计。";

/** 本次打开的那次 `getMyScope`：在途、取得或失败（带信封文案）。 */
export type MyScopeState =
  | { status: "loading" }
  | { status: "ready"; scope: MyScope }
  | { status: "failed"; message: string };

/**
 * 当前账号的部门与项目组，由面板持有一份、两个对话框共用。`load()` 在打开对话框的点击里调用（不在 effect 里），
 * 每次恰发出一次 `getMyScope()`，只采用最后一次打开的应答。
 */
export function useMyScope(client: Pick<ApiClient, "getMyScope">) {
  const [state, setState] = useState<MyScopeState>({ status: "loading" });
  const opened = useRef(0);
  const load = useCallback(() => {
    const own = ++opened.current;
    const settle = (next: MyScopeState) => {
      if (own === opened.current) setState(next);
    };
    setState({ status: "loading" });
    client.getMyScope().then(
      (scope) => settle({ status: "ready", scope }),
      (error: unknown) => settle({ status: "failed", message: messageOf(error) }),
    );
  }, [client]);
  return { state, load };
}

/** 下拉选中的组：用户选过的，否则 `current`（仍在 `groups` 里时），否则首项；没有组或没取到范围时为 `null`。 */
export function chosenGroup(
  state: MyScopeState,
  picked: string | null,
  current: string | null = null,
): string | null {
  if (state.status !== "ready") return null;
  const { groups } = state.scope;
  const has = (id: string | null) => id !== null && groups.some((group) => group.id === id);
  if (has(picked)) return picked;
  return has(current) ? current : (groups[0]?.id ?? null);
}

/** 一档对应的请求键：`group` 档带 `groupId`（没有组时为 `null`，不可提交），其余档只带 `scope`。 */
export function scopeInput(scope: Scope, groupId: string | null): KbScopeInput | null {
  if (scope !== "group") return { scope };
  return groupId === null ? null : { scope, groupId };
}

/** 打开时预选的档：当前档已不可选（没有部门、或当前组不在 `groups` 里）时为 `null`。 */
function initialScope({ scope, group }: BaseView["scope"], mine: MyScope): Scope | null {
  if (scope === "dept" && mine.department === null) return null;
  if (scope === "group" && !mine.groups.some(({ id }) => id === group?.id)) return null;
  return scope;
}

const groupText = (group: MyScope["groups"][number]) => `${group.name}（${group.memberCount} 人）`;

function GroupField({
  groups,
  groupId,
  disabled,
  onChange,
}: {
  groups: MyScope["groups"];
  groupId: string | null;
  disabled: boolean;
  onChange(groupId: string): void;
}) {
  const id = useId();
  if (groups.length === 0) return <p className={MUTED}>{NO_GROUP}</p>;
  const chosen = groups.find((group) => group.id === groupId);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>项目组</Label>
      <Select disabled={disabled} onValueChange={onChange} value={groupId ?? ""}>
        <SelectTrigger className="w-full" id={id}>
          <SelectValue>{chosen ? groupText(chosen) : null}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {groups.map((group) => (
            <SelectItem key={group.id} value={group.id}>
              {groupText(group)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * 四档单选（每档带说明，经 `aria-describedby` 关联）、部门旁注与 `项目组可见` 的下拉或无组提示。没取到范围（在途或
 * 失败）时 `fallback` 决定可选的档：新建对话框 `"me-only"` 只留 `仅自己可见`，范围对话框 `"none"` 全部禁用；失败
 * 时以 `role="alert"` 显示信封文案。`disabled`（请求在途）禁用全部档与下拉。
 */
export function ScopeFields({
  state,
  value,
  groupId,
  onChange,
  onGroupChange,
  fallback,
  disabled = false,
}: {
  state: MyScopeState;
  value: Scope | null;
  groupId: string | null;
  onChange(scope: Scope): void;
  onGroupChange(groupId: string): void;
  fallback: "me-only" | "none";
  disabled?: boolean;
}) {
  const id = useId();
  const mine = state.status === "ready" ? state.scope : null;
  const enabled = (scope: Scope) =>
    mine ? scope !== "dept" || mine.department !== null : fallback === "me-only" && scope === "me";
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        aria-label="可见范围"
        onValueChange={(next) => onChange(next as Scope)}
        value={value ?? ""}
      >
        {SCOPES.map((scope) => (
          <div className="flex items-start gap-2" key={scope.value}>
            <RadioGroupItem
              aria-describedby={`${id}-${scope.value}-note`}
              disabled={disabled || !enabled(scope.value)}
              id={`${id}-${scope.value}`}
              value={scope.value}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-${scope.value}`}>{scope.label}</Label>
              <p className={MUTED} id={`${id}-${scope.value}-note`}>
                {scope.description}
              </p>
              {scope.value === "dept" && mine?.department === null ? (
                <p className={MUTED}>{NO_DEPT}</p>
              ) : null}
            </div>
          </div>
        ))}
      </RadioGroup>
      {mine && value === "group" ? (
        <GroupField
          disabled={disabled}
          groupId={groupId}
          groups={mine.groups}
          onChange={onGroupChange}
        />
      ) : null}
      <DialogAlert message={state.status === "failed" ? state.message : null} />
    </div>
  );
}

/**
 * 范围对话框（可访问名 `「<库名>」可见范围`）：取得范围后预选当前档，`保存` 恰调用一次 `setKnowledgeBaseScope`
 *（选的档与当前相同也发，服务端不写、不审计）。在途时 `保存`、`取消`、四档与下拉都禁用，Escape 与遮罩关不掉；
 * 成功交出应答的视图，失败的信封文案以 `role="alert"` 留在框内、选择保持。
 */
export function ScopeDialog({
  base,
  state,
  client,
  restoreFocus,
  onSaved,
  onCancel,
}: {
  base: BaseView;
  state: MyScopeState;
  client: Pick<ApiClient, "setKnowledgeBaseScope">;
  restoreFocus(): void;
  onSaved(view: BaseView): void;
  onCancel(): void;
}) {
  const [picked, setPicked] = useState<Scope | null>(null);
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 在途标记：同一帧里的第二次点击还看不到重渲染，靠它拦下。 */
  const saving = useRef(false);
  const value = state.status === "ready" ? (picked ?? initialScope(base.scope, state.scope)) : null;
  const groupId = chosenGroup(state, pickedGroup, base.scope.group?.id ?? null);
  const input = value === null ? null : scopeInput(value, groupId);

  async function save() {
    if (input === null || saving.current) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      onSaved(await client.setKnowledgeBaseScope(base.id, input));
    } catch (failure) {
      setError(messageOf(failure));
      setPending(false);
    } finally {
      saving.current = false;
    }
  }

  return (
    <KbDialog
      onCancel={onCancel}
      pending={pending}
      restoreFocus={restoreFocus}
      title={`「${base.name}」可见范围`}
    >
      <div className="flex flex-col gap-3">
        <ScopeFields
          disabled={pending}
          fallback="none"
          groupId={groupId}
          onChange={setPicked}
          onGroupChange={setPickedGroup}
          state={state}
          value={value}
        />
        <p className={MUTED}>{AUDIT_HINT}</p>
        <DialogAlert message={error} />
        <DialogActions
          disabled={input === null}
          label="保存"
          onCancel={onCancel}
          onConfirm={() => void save()}
          pending={pending}
        />
      </div>
    </KbDialog>
  );
}
