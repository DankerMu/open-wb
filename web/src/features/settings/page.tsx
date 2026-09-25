import { type ReactNode, useEffect, useId, useState } from "react";
import { ApiError, REQUEST_FAILED_MESSAGE, type ServiceInfo } from "../../lib/api.js";
import { BrandMark, SegmentedControl } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { useTheme } from "../theme/index.js";

const THEME_OPTIONS = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

function SettingsRow({ children, control }: { children: ReactNode; control?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">{children}</div>
      {control ? <div className="settings-row-control">{control}</div> : null}
    </div>
  );
}

function AppearanceCard() {
  const { resolvedTheme, selectedTheme, setTheme } = useTheme();
  const headingId = useId();
  const current = resolvedTheme === "dark" ? "深色" : "浅色";

  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 className="settings-sec-h" id={headingId}>
        外观
      </h2>
      <div className="settings-card">
        <SettingsRow
          control={
            <SegmentedControl
              label="主题"
              onValueChange={setTheme}
              options={THEME_OPTIONS}
              value={selectedTheme}
            />
          }
        >
          <div className="settings-row-title">主题</div>
          <div className="settings-row-desc">浅色 / 深色 / 跟随系统 · 即时生效并持久保存</div>
        </SettingsRow>
        <SettingsRow>
          <div aria-hidden="true" className="settings-row-title">
            当前生效
          </div>
          <div aria-hidden="true" className="settings-row-desc">
            {`${current} · 持久保存于 localStorage`}
          </div>
          <span className="ui-sr-only">{`当前生效：${current}`}</span>
        </SettingsRow>
      </div>
    </section>
  );
}

function AboutCard() {
  const headingId = useId();
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
    <section aria-labelledby={headingId} className="settings-section">
      <h2 className="settings-sec-h" id={headingId}>
        关于
      </h2>
      <div className="settings-card">
        <div className="settings-row">
          <BrandMark size={32} />
          <div className="settings-row-text">
            {loading ? <div className="settings-row-desc">正在读取服务信息</div> : null}
            {error ? (
              <p className="ui-alert" role="alert">
                {error}
              </p>
            ) : null}
            {serviceInfo ? (
              <>
                <div className="settings-row-title">{serviceInfo.name}</div>
                <div className="settings-row-desc">{`版本 ${serviceInfo.version}`}</div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SettingsPage() {
  return (
    <div className="settings-page">
      <AppearanceCard />
      <AboutCard />
    </div>
  );
}
