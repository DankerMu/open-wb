import { type ReactNode, useEffect, useId, useState } from "react";
import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAuth } from "@/features/auth/index";
import { useTheme } from "@/features/theme/index";
import { ApiError, REQUEST_FAILED_MESSAGE, type ServiceInfo } from "@/lib/api";
import { BrandMark, Icon } from "@/ui/index";

const THEME_OPTIONS = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

/** 一张设置卡：卡外的二级标题 + 卡体，整段是以该标题命名的 region。 */
function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="max-w-[860px] not-first:mt-[22px]">
      <h2 className="mb-3 text-[13.5px] font-bold" id={headingId}>
        {title}
      </h2>
      <Card className="gap-0 border bg-secondary px-4 py-1 ring-0">{children}</Card>
    </section>
  );
}

/** 卡内一行：左侧标题 + 说明，右侧控件；窄屏下控件换行。行与行之间一条分隔线。 */
function SettingsRow({ children, control }: { children: ReactNode; control?: ReactNode }) {
  return (
    <div
      className="flex items-center gap-4 border-t py-[13px] first:border-t-0 max-[760px]:flex-wrap"
      data-slot="settings-row"
    >
      {children}
      {control ? <div className="ml-auto shrink-0">{control}</div> : null}
    </div>
  );
}

const ROW_TITLE = "text-[13.5px] font-[650] wrap-anywhere";
const ROW_DESC = "mt-0.5 text-xs wrap-anywhere text-muted-foreground";

/**
 * 主题单选组，排成分段样式。选项文字是 RadioGroupItem 的 children，可访问名即来自内容；
 * 拷入层自带的圆形外观与圆点指示器在这里用 className 覆盖/隐藏，不改拷入文件。
 */
function ThemeControl() {
  const { selectedTheme, setTheme } = useTheme();

  return (
    <RadioGroup
      aria-label="主题"
      className="inline-flex w-auto gap-0 rounded-full bg-(--wb-bg-hover-light) p-[3px]"
      onValueChange={(next) => {
        const option = THEME_OPTIONS.find((candidate) => candidate.value === next);
        if (option) setTheme(option.value);
      }}
      value={selectedTheme}
    >
      {THEME_OPTIONS.map((option) => (
        <RadioGroupItem
          className="aspect-auto size-auto cursor-pointer items-center border-0 bg-transparent px-[15px] py-1.5 text-[12.5px] whitespace-nowrap text-muted-foreground after:hidden not-data-[state=checked]:hover:text-foreground data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-transparent dark:data-[state=checked]:bg-primary [&>[data-slot=radio-group-indicator]]:hidden"
          key={option.value}
          value={option.value}
        >
          {option.label}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}

function AppearanceCard() {
  const { resolvedTheme } = useTheme();
  const current = resolvedTheme === "dark" ? "深色" : "浅色";

  return (
    <SettingsSection title="外观">
      <SettingsRow control={<ThemeControl />}>
        <div className="min-w-0">
          <div className={ROW_TITLE}>主题</div>
          <div className={ROW_DESC}>浅色 / 深色 / 跟随系统 · 即时生效并持久保存</div>
        </div>
      </SettingsRow>
      <SettingsRow>
        <div className="relative min-w-0">
          <div aria-hidden="true" className={ROW_TITLE}>
            当前生效
          </div>
          <div aria-hidden="true" className={ROW_DESC}>
            {`${current} · 持久保存于 localStorage`}
          </div>
          <span className="sr-only">{`当前生效：${current}`}</span>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function AboutCard() {
  const { loadServiceInfo } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void loadServiceInfo(controller.signal)
      .then((result) => {
        if (!active) {
          return;
        }

        if (result) {
          setServiceInfo(result);
        } else {
          setError(REQUEST_FAILED_MESSAGE);
        }
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof ApiError ? reason.message : REQUEST_FAILED_MESSAGE);
          setLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [loadServiceInfo]);

  return (
    <SettingsSection title="关于">
      <SettingsRow>
        <BrandMark size={32} />
        <div className="min-w-0">
          {loading ? <div className={ROW_DESC}>正在读取服务信息</div> : null}
          {error ? (
            <p
              className="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text)"
              role="alert"
            >
              <Icon name="triangle-alert" size={12} />
              {error}
            </p>
          ) : null}
          {serviceInfo ? (
            <>
              <div className={ROW_TITLE}>{serviceInfo.name}</div>
              <div className={ROW_DESC}>{`版本 ${serviceInfo.version}`}</div>
            </>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

export function SettingsPage() {
  return (
    <div className="overflow-auto px-7 pt-6 pb-10 max-[760px]:px-4">
      <AppearanceCard />
      <AboutCard />
    </div>
  );
}
