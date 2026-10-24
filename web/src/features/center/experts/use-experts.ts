import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError, type ExpertView, REQUEST_FAILED_MESSAGE } from "@/lib/api";
import { type ExpertFormValues, toExpertInput } from "./validate.js";

/**
 * 「专家」tab 的数据与操作（experts「中心「专家」tab」，s1d-experts-skills 任务 7.3）。请求时机：挂载恰一次
 * `listExperts`，此后只在新建 / 编辑 / 删除成功后各恰一次；`listSkills` 只在对话框每次打开时恰一次（在打开它的
 * 事件里发出，面板挂载不取）。页面只按 `listExperts` 的结果显示，不拼接写操作的返回值。
 *
 * 错误分流：新建 / 编辑的 `ApiError` 留在对话框内显示（对话框不关、不重取）；删除失败与「已有列表时重取失败」
 * 显示在面板顶部；首次读取失败是面板内错误（不渲染卡片与 `新建专家`）。`listSkills` 失败不提示：技能多选只剩
 * 专家已有的名称（新建时为空），照样可以提交。
 */

type ListState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; experts: ExpertView[] };

/**
 * 打开的表单对话框：`opened` 为 null 是新建，否则是编辑该视图（打开那一刻的）；`skillNames` 是技能清单的名称
 *（读取中为 null，失败为空表）。
 */
type FormState = {
  opened: ExpertView | null;
  pending: boolean;
  error: string | null;
  skillNames: readonly string[] | null;
};
type RemoveState = { expert: ExpertView; pending: boolean };

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}

export function useExperts(client: ApiClient) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [remove, setRemove] = useState<RemoveState | null>(null);
  const sequence = useRef(0);
  const opening = useRef(0);
  const loaded = useRef(false);

  /** 只采用最后一次发出的列表请求的结果；已有列表时失败只在页顶提示，列表保留。 */
  const reload = useCallback(async () => {
    const own = ++sequence.current;
    try {
      const experts = await client.listExperts();
      if (own !== sequence.current) return;
      loaded.current = true;
      setList({ status: "ready", experts });
    } catch (error) {
      if (own !== sequence.current) return;
      if (loaded.current) setNotice(messageOf(error));
      else setList({ status: "failed", message: messageOf(error) });
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 打开对话框并恰取一次技能清单；结果只落在同一次打开的对话框上。 */
  const openForm = (opened: ExpertView | null) => {
    setNotice(null);
    const own = ++opening.current;
    setForm({ opened, pending: false, error: null, skillNames: null });
    const settle = (skillNames: readonly string[]) => {
      if (own !== opening.current) return;
      setForm((current) => (current ? { ...current, skillNames } : current));
    };
    client.listSkills().then(
      ({ skills }) => settle(skills.map((skill) => skill.name)),
      // 读不到技能清单不是表单错误：多选只剩已有名称，照样可以提交（规格要求不提示）。
      () => settle([]),
    );
  };

  return {
    list,
    notice,
    form,
    remove,

    openCreate() {
      openForm(null);
    },
    openEdit(expert: ExpertView) {
      openForm(expert);
    },
    closeForm() {
      setForm((current) => (current?.pending ? current : null));
    },

    /** 恰调用一次 `createExpert` / `updateExpert`；成功即关闭对话框并重取，失败留在框内。 */
    async submit(values: ExpertFormValues) {
      if (!form || form.pending) return;
      const { opened } = form;
      setForm({ ...form, pending: true, error: null });
      const input = toExpertInput(values);
      try {
        await (opened ? client.updateExpert(opened.id, input) : client.createExpert(input));
      } catch (error) {
        setForm((current) =>
          current ? { ...current, pending: false, error: messageOf(error) } : current,
        );
        return;
      }
      setForm(null);
      await reload();
    },

    askRemove(expert: ExpertView) {
      setNotice(null);
      setRemove({ expert, pending: false });
    },
    cancelRemove() {
      setRemove((current) => (current?.pending ? current : null));
    },
    /**
     * 恰调用一次 `deleteExpert`。成功时先调 `onGone`——调用方据此不再把焦点还给那张卡的按钮（重取可能晚于确认框
     * 关闭才结算），再重取；失败在页顶提示（卡片仍在），`onGone` 不调。
     */
    async confirmRemove(onGone?: () => void) {
      if (!remove || remove.pending) return;
      const { expert } = remove;
      setRemove({ expert, pending: true });
      try {
        await client.deleteExpert(expert.id);
      } catch (error) {
        setRemove(null);
        setNotice(messageOf(error));
        return;
      }
      onGone?.();
      setRemove(null);
      await reload();
    },
  };
}
