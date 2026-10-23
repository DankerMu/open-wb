import { useId, useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/features/auth/index";
import type { ApiClient, SkillList } from "@/lib/api";
import { useSkills } from "./use-skills.js";

const NOTE = "只影响新建的会话；已有会话在输入框的「能力」里修改";
const EMPTY = "尚未安装平台技能";

type Skill = SkillList["skills"][number];

/**
 * 中心页「技能」tab（skill-switches「中心「技能」tab」）：页顶说明、平台技能列表（名称、描述）与每项的
 * `默认启用` 开关（账号缺省停用列表）。`client` 供用例注入；缺省取会话客户端（专家 tab 的先例）。
 */
export function SkillsPanel({ client }: { client?: ApiClient }) {
  return client ? <Skills client={client} /> : <SessionSkills />;
}

function SessionSkills() {
  const { createSessionClient } = useAuth();
  const client = useMemo(() => createSessionClient(), [createSessionClient]);
  return <Skills client={client} />;
}

function Skills({ client }: { client: ApiClient }) {
  const { state, toggle } = useSkills(client);

  return (
    <section className="flex min-w-0 flex-col gap-3 pt-4">
      <p className="ui-muted m-0">{NOTE}</p>
      {state.status === "loading" ? <p className="ui-muted m-0">正在读取技能</p> : null}
      {state.status === "failed" ? (
        <p className="ui-alert" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === "ready" ? (
        <>
          {state.error ? (
            <p className="ui-alert" role="alert">
              {state.error}
            </p>
          ) : null}
          {state.list.skills.length === 0 ? (
            <p className="ui-muted m-0">{EMPTY}</p>
          ) : (
            <ul
              aria-label="技能列表"
              className="m-0 flex list-none flex-col divide-y divide-border rounded-lg border border-border p-0"
              // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
              role="list"
            >
              {state.list.skills.map((skill) => (
                <SkillRow
                  enabled={!state.list.disabledSkills.includes(skill.name)}
                  key={skill.name}
                  onToggle={(enabled) => void toggle(skill.name, enabled)}
                  pending={state.pending}
                  skill={skill}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

type RowProps = {
  skill: Skill;
  enabled: boolean;
  pending: boolean;
  onToggle(enabled: boolean): void;
};

function SkillRow({ skill, enabled, pending, onToggle }: RowProps) {
  const titleId = useId();
  return (
    <li aria-labelledby={titleId} className="flex items-center gap-3 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="m-0 text-sm font-medium [overflow-wrap:anywhere]" id={titleId}>
          {skill.name}
        </h3>
        {skill.description === "" ? null : (
          <p className="ui-muted m-0 text-xs [overflow-wrap:anywhere]">{skill.description}</p>
        )}
      </div>
      <span aria-hidden="true" className="ui-muted shrink-0 text-xs">
        默认启用
      </span>
      <Switch
        aria-label={`默认启用 ${skill.name}`}
        checked={enabled}
        disabled={pending}
        onCheckedChange={onToggle}
      />
    </li>
  );
}
