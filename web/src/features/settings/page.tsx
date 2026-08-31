import { useEffect, useState } from "react";
import { ApiError, REQUEST_FAILED_MESSAGE, type ServiceInfo } from "../../lib/api.js";
import { useAuth } from "../auth/index.js";
import { useTheme } from "../theme/index.js";

function AppearanceCard() {
  const { resolvedTheme, selectedTheme, setTheme } = useTheme();
  const currentTheme = resolvedTheme === "dark" ? "深色" : "浅色";
  const themeOptions = [
    ["light", "浅色"],
    ["dark", "深色"],
    ["system", "跟随系统"],
  ] as const;

  return (
    <section>
      <h2>外观</h2>
      <fieldset>
        <legend>主题</legend>
        <div aria-label="主题" role="radiogroup">
          {themeOptions.map(([value, label]) => (
            <label key={value}>
              <input
                checked={selectedTheme === value}
                name="theme"
                onChange={() => setTheme(value)}
                type="radio"
                value={value}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <p>{`当前生效：${currentTheme}`}</p>
    </section>
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
    <section>
      <h2>关于</h2>
      {loading ? <p>正在读取服务信息</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {serviceInfo ? (
        <p>
          <span>{serviceInfo.name}</span>
          <span>{`版本 ${serviceInfo.version}`}</span>
        </p>
      ) : null}
    </section>
  );
}

export function SettingsPage() {
  return (
    <div>
      <h1>设置</h1>
      <AppearanceCard />
      <AboutCard />
    </div>
  );
}
