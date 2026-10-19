/**
 * The omp child's environment and the sudo `--preserve-env=` list (omp-runtime「子进程 spawn 契约」,
 * omp-uid-isolation「OMP_USER 配置与 sudo spawn 前缀」). A closed allowlist: of `process.env` only
 * `PATH`, `LANG` and `TMPDIR` are read.
 */
import { ompAgentDir, ompHome, ompHostOverlayPath, ompXdgHome } from "./state-layout.js";

/**
 * Fixed whether or not `BROWSER_BIN` is set; sudo keeps exactly these names. The two browser pins
 * must be here too, or sudo drops them and they stop pinning.
 */
export const SUDO_PRESERVE_ENV =
  "--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,PI_CODING_AGENT_DIR,PI_CONFIG_FILES,PI_CONFIG_DIR,OMP_PROFILE,PI_PROFILE,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_EXECUTABLE_PATH";

export function ompSpawnEnv(opts: {
  stateDir: string;
  token: string;
  browserBin?: string | undefined;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: ompHome(opts.stateDir),
    XDG_DATA_HOME: ompXdgHome(opts.stateDir, "data"),
    XDG_STATE_HOME: ompXdgHome(opts.stateDir, "state"),
    XDG_CACHE_HOME: ompXdgHome(opts.stateDir, "cache"),
    // omp loads `<cwd>/.env` but never over a non-empty variable: these five are what omp does
    // by default, set so a dotenv cannot move the managed config (issue #802). The agent dir must
    // stay the default string itself, or omp stops redirecting runtime state to XDG.
    PI_CODING_AGENT_DIR: ompAgentDir(opts.stateDir),
    PI_CONFIG_FILES: ompHostOverlayPath(opts.stateDir),
    PI_CONFIG_DIR: ".omp",
    OMP_PROFILE: "default",
    PI_PROFILE: "default",
    WORKBUDDY_MODEL_TOKEN: opts.token,
    // omp's final relay / cmux switches: a workspace `.env` setting them to 1 would beat the
    // overlay's `relay: false` / `cmux: false` (#1529). The literal 0 is non-empty, so no dotenv
    // overrides it; an empty string would not hold.
    PI_BROWSER_RELAY: "0",
    PI_BROWSER_CMUX: "0",
  };
  if (process.env.LANG !== undefined) {
    env.LANG = process.env.LANG;
  }
  if (process.env.TMPDIR !== undefined) {
    env.TMPDIR = process.env.TMPDIR;
  }
  // Only the deployment's BROWSER_BIN; the parent's own PUPPETEER_EXECUTABLE_PATH never passes.
  if (opts.browserBin !== undefined) {
    env.PUPPETEER_EXECUTABLE_PATH = opts.browserBin;
  }
  return env;
}
