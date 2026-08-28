# 04 — WorkBuddy 原生层 / 打包框架 结构分析

> 结论先行：这是一个标准 Electron **macOS arm64** 桌面应用（`com.workbuddy.workbuddy-ai`）。Electron 版本 **37.10.3 / Chromium 138.0.7204.251**。原生层包含 **3 个 N-API 原生模块**：`turing_sdk`（腾讯 T-Sec TuringShield 设备风险检测/设备指纹，产出 `X-Device-Token`）、`wechat-copydata-decoder`（Windows 解码微信 WM_COPYDATA 载荷）、`@tencent/qimei-node`（腾讯 QIMEI 设备指纹，产出 `qimei36`）。外加 **koffi FFI** 仅在 Windows 下调用 `user32.dll`/`kernel32.dll` 发送 WM_COPYDATA。**TuringShield 在 macOS 上被代码显式禁用（`isTuringSdkTemporarilyDisabled(darwin)`），但 native 产物仍随包分发。**

---

## 1. Electron 版本与打包框架

### 1.1 版本证据

| 证据源 | 输出 |
|---|---|
| `Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist` `CFBundleShortVersionString` | **37.10.3** |
| `strings "Electron Framework"` | `Chrome/138.0.7204.251 Electron/37.10.3`、`37.10.3`、`1.51.0`（Node 内嵌版本号） |
| `Contents/Info.plist` | `CFBundleIdentifier=com.workbuddy.workbuddy-ai`、`CFBundleShortVersionString=5.4.2`、`CFBundleVersion=5.4.2`（**应用版本 5.4.2 ≠ Electron 版本 37.10.3**） |
| `Contents/Frameworks/Electron Framework.framework/Versions/` | `Current -> A`（单一薄壳，非 fat/universal） |

框架结构：

```
Contents/Frameworks/
  Electron Framework.framework/          # 主运行时（链接 Squirrel/Mantle/ReactiveObjC）
  Mantle.framework/                       # 模型层框架（Squirrel 依赖）
  ReactiveObjC.framework/                 # 响应式编程框架（Squirrel 依赖）
  Squirrel.framework/                     # macOS 自动更新框架
  WorkBuddy AI Helper.app                 # 主 Helper
  WorkBuddy AI Helper (GPU).app
  WorkBuddy AI Helper (Plugin).app
  WorkBuddy AI Helper (Renderer).app
  WorkBuddy Legacy Auto Launch Cleaner.app
  WorkBuddy Repair.app
```

### 1.2 各 Helper 职责（`Info.plist` CFBundleIdentifier）

| App | CFBundleIdentifier | CFBundleName | 版本 |
|---|---|---|---|
| `WorkBuddy AI Helper.app` | `com.workbuddy.workbuddy-ai.helper` | Electron Helper | 5.4.2 |
| `WorkBuddy AI Helper (GPU).app` | `com.workbuddy.workbuddy-ai.helper.GPU` | Electron Helper (GPU) | 5.4.2 |
| `WorkBuddy AI Helper (Plugin).app` | `com.workbuddy.workbuddy-ai.helper.Plugin` | Electron Helper (Plugin) | 5.4.2 |
| `WorkBuddy AI Helper (Renderer).app` | `com.workbuddy.workbuddy-ai.helper.Renderer` | Electron Helper (Renderer) | 5.4.2 |
| `WorkBuddy Legacy Auto Launch Cleaner.app` | `com.workbuddy.workbuddy` | WorkBuddy Legacy Auto Launch Cleaner | 1.0.0 (build 1) |
| `WorkBuddy Repair.app` | `com.workbuddy.repair` | RepairApp | 1.0.0 (build 1) |

- Helper 是 Electron 标准的 4+1 进程模型拆分：主 Helper（无后缀）、GPU、Plugin、Renderer。这是 Electron 默认打包产物，无自定义进程。
- `Legacy Auto Launch Cleaner` 与 `Repair` 是 WorkBuddy 自己附带的两个独立可执行 App（各 1.0.0），用于清理旧版开机自启项/修复安装；非 Electron 标准产物。

### 1.3 Squirrel / Mantle / ReactiveObjC 角色

- `Electron Framework` `otool -L` 直接链接三者的 `@rpath` 版本：
  ```
  @rpath/Squirrel.framework/Squirrel
  @rpath/ReactiveObjC.framework/ReactiveObjC
  @rpath/Mantle.framework/Mantle
  ```
- **Squirrel.framework** = Squirrel.Mac，Electron 内置 macOS `autoUpdater` 的底层更新框架（`@electron/...` 打包时自动拷入 app 的 Frameworks）。
- **Mantle.framework** = 模型/值对象框架，是 Squirrel 的依赖（用于 update server API 的模型建模）。
- **ReactiveObjC.framework** = ReactiveCocoa 的 Objective-C 部分，Squirrel 的另一个依赖（响应式信号/订阅）。
- 这三者属于 Electron macOS 自动更新基础设施，[INFERENCE] 非应用直接使用的业务库。

---

## 2. `turing_sdk.node`（腾讯 T-Sec TuringShield）

### 2.1 文件与引用的 JS 桥

- 路径：`app_asar/native/turing-sdk/build/Release/turing_sdk.node`
- `file`：`Mach-O 64-bit bundle arm64`（1,053,440 字节，单架构 arm64，非 fat）
- `package.json`：`name=workbuddy-turing-sdk`，`description="N-API bridge for the Tencent T-Sec TuringShield desktop SDK"`。
- `index.cjs` 全文（`app_asar/native/turing-sdk/index.cjs`）：

  ```js
  'use strict';
  const path = require('node:path');
  let binding; let loadError;
  const supportedPlatform = process.platform === 'darwin' || process.platform === 'win32';
  if (supportedPlatform) {
      try { binding = require(path.join(__dirname, 'build', 'Release', 'turing_sdk.node')); }
      catch (error) { loadError = error; binding = null; }
  } else { binding = null; }
  function isSupported() { return supportedPlatform && binding != null; }
  function getLoadError() { return loadError ? String(loadError.message || loadError) : null; }
  function requireBinding() {
      if (!binding) throw new Error(`Turing SDK native binding unavailable: ${getLoadError() || `unsupported platform ${process.platform}`}`);
      return binding;
  }
  module.exports = {
      isSupported, getLoadError,
      configure(channelId, productName, productVersion) { return requireBinding().configure(channelId, productName, productVersion); },
      fetchDeviceToken(options) { return requireBinding().fetchDeviceToken(options); },
  };
  ```

  → 导出两个 N-API 方法：`configure(channelId, productName, productVersion)`、`fetchDeviceToken(options)`（返回 Promise/Token 字符串）。

### 2.2 依赖（`otool -L`）

链接系统库：`AppKit`, `CoreGraphics`, `CoreLocation`, `CoreMotion`, `CoreWLAN`, `DiskArbitration`, `Foundation`, `IOKit`, `Security`, `SystemConfiguration`, `CFNetwork`, `CoreFoundation`, `WebKit`, `libresolv`, `libz`, `libc++`, `libobjc`, `libSystem`。

> 这类系统库组合（CoreLocation 定位 + CoreMotion 运动传感器 + CoreWLAN WiFi + IOKit 硬件 + Security 钥匙串）是**设备指纹/风险采集**的典型特征。

### 2.3 `nm` 符号（未去符号，可读）

- 顶层导出仅 `N-API` 注册入口：`T _napi_register_module_v1`、`T _node_api_module_get_api_version_v1`。
- 大量 **Objective-C 类**（`_OBJC_CLASS_$_…`），类名含 `TuringShieldBASE`、`TuringAnalysisMessageRecordBASE`、`TuringRiskTokenBASE`、`TuringPostRuleBASE`，以及混淆名 `turing_HI…BASE`。
- `strings` 关键内容：
  - NSUserDefaults 命名空间：`com.tencent.TuringShield.*`、`com.turingshield.identifying.guid.{general,Local,Cloud}`、`com.turingshield.identifying.idfb.*`。
  - 协议标识：`RiskDetectServer.DeviceTokenV3`、`RiskDetectServer.CSRiskFeature`、`RiskDetectServer.SCGateway`、`MTMFShark.CSShark/SCShark`、`TMFSharkPublicKeyTag`（RSA 公钥 tag），即腾讯 **TMF Shark**（移动安全框架）协议。
  - 进程/环境检测（anti-tamper/anti-debug）：`+[turing_HIreYaasq8lbjBASE isBeingDebugged]`、`_isRunningInVirtualMachine`、`_isRunningInSandbox`、`_isMacCatalyst`、`_isIPadOS`、`_isCarPlay`、`_collectProcessInfo`、`_detectRuntimePlatform`、`_detectProcessCategory`、`IDFA`、`IMEI`。
  - N-API 属性名：`configure`、`fetchDeviceToken`、`channel_id`、`Unable to read configure arguments`、`Turing SDK device token request timed out`、`TuringShield standardService is unavailable`。

### 2.4 谁在调用（`main/index.js`）

全部落在 `#region src/main/integrations/turing-sdk/*`（`main/index.js:16549-16825`）：

- `loadTuringNativeBinding()`：`process.platform` 非 darwin/win32 直接失败；`resolveBundledAsset("native","turing-sdk")` → `dynamicRequire(addonDir)` → 调 `binding.isSupported()`。
- `TuringSdkService` 类：`configure(channelId, productName, productVersion)` + `fetchDeviceToken(options)`；带 in-memory 缓存、软过期（默认 5 分钟）、退避重试（30s→5min 指数）、15s 请求超时。
- `resolveConfiguration()`：读 `process.env.WORKBUDDY_TURING_CHANNEL_ID` / `WORKBUDDY_TURING_TIMEOUT_MS`，否则读产品配置 `productConfig.config.turingSdk.{channelId,requestTimeoutMs}`。
- **关键：`isTuringSdkTemporarilyDisabled(platform)` 返回 `platform === "darwin"`**（`main/index.js:16696-16710`）→ **macOS 上 SDK 被显式禁用**，"temporarily disabled on macOS"；`getTuringSdkService()` 在 darwin 下返回 `undefined`，不会加载 binding。native 产物与 Python 一并随包分发，但 macOS 运行时不调用。
- 设备 token 注入请求头：`tar.js:28194` `TURING_SHIELD_ID_HEADER = "X-Device-Token"`；在 `server.js:159317` 用于 `beforePromptExpertActivation` 时给 agent CLI 请求附加 `X-Device-Token` 头；`tar.js:28618` 同理注入。
- 启动预取：`prefetchTuringDeviceTokenStep()`（`post-ready.prefetch-turing-device-token`，`critical:false`，fire-and-forget 不 await，避免钥匙串授权阻断首屏）。

### 2.5 TuringShield 是什么

TuringShield（腾讯安全 · 天御 / T-Sec 终端风险检测 SDK）是腾讯的**设备风险检测 + 设备指纹** SDK。能力（来自 `nm`/`strings` 证据）：

- 采集设备环境信息（进程、bundle id、可执行路径、平台、沙箱/虚拟机/调试状态、IDFA/IMEI、定位、网络、磁盘/启动时间/文件时间戳）。
- 反调试/反篡改（`isBeingDebugged`、虚拟环境检测、环境特征分析）。
- 与 T-Sec 后端通过 TMF Shark / RiskDetectServer 协议握手，产出**设备 token**（`X-Device-Token`，供业务侧标注/风控）。
- `configure` 需要合法的 channelId（T-Sec 分配的正整数）。

### 2.6 `PrivacyInfo.xcprivacy`（`Resources/TuringShield.bundle/PrivacyInfo.xcprivacy`）

```
NSPrivacyCollectedDataTypes:
  DeviceID (linked=false, tracking=true, purpose=AppFunctionality)
NSPrivacyAccessedAPITypes:
  FileTimestamp     3B52.1
  SystemBootTime    35F9.1
  DiskSpace         E174.1
  UserDefaults      CA92.1
```

> 收集**设备标识（DeviceID）用于 App 功能**（标记 tracking=true，即可能被用于跨 app 追踪/风控），并访问文件时间戳、系统启动时间、磁盘空间、UserDefaults。与 SDK 的设备指纹/风险采集行为一致。

### 2.7 加固 / 签名

- 非 `-sect`，`Info.plist=not bound`（裸 dylib 型 .node）。
- `codesign -dv`：`Identifier=turing_sdk`、`TeamIdentifier=FN2V63AD2J`、`flags=0x10000(runtime)`（hardened runtime）、`Timestamp=Aug 24, 2026`。
- **无明文网络域名**：`strings` 未匹配到 `.com/.cn` 等真实 host，仅协议标识名（`RiskDetectServer.*`、`MTMFShark.*`）。[INFERENCE] 实际 T-Sec 网关地址在运行时经加密配置/DNS 解析，不落明文。

---

## 3. `wechat_copydata_decoder`

- 路径：`app_asar/native/wechat-copydata-decoder/build/Release/wechat_copydata_decoder.node`
- `file`：`Mach-O 64-bit bundle arm64`（69,664 字节）。`package.json`：`"Tiny N-API addon that decodes a Windows COPYDATASTRUCT from an Electron hookWindowMessage lParam pointer buffer"`。
- `index.js`：`isSupported()` 返回 `process.platform === "win32" && binding != null`；导出 `readCopyDataPayload(lParam)`、`getPointerSize()`。
- API：`readCopyDataPayload(lParam)` 从 `hookWindowMessage` 收到的 `lParam` 指针缓冲解码 Windows `COPYDATASTRUCT` 载荷；`getPointerSize()` 返回 4/8。
- 依赖极轻：`otool -L` 仅 `libc++.1.dylib`、`libSystem.B.dylib`。
- 符号：`ReadCopyDataPayload`、`GetPointerSize`、`napi_register_module_v1`、`napi_define_properties`、`napi_create_uint32`、`napi_throw_error`。
- **注意**：`.node` 是 macOS arm64 编译产物，但 `isSupported()` 只在 `win32` 返回 true（`process.arch` 判断指针宽度）。[INFERENCE] 该 .node 设计为按平台 `@electron/rebuild` 到目标 ABI；dist 包里打包的 mac 构建是 dev/build 附带，运行时仅 Windows 激活。

### 调用点（`main/index.js:24413-24615`，region `wechat-chat-history/win-transport.ts`）

- `WM_COPYDATA = 74`、`WECHAT_CHAT_HISTORY_COPYDATA_MAGIC = 4034109776`。
- `NativeWechatWinCopyDataTransport`：`mainWindow.hookWindowMessage(74, (wParam,lParam)=>…)`；收到消息用 `this.binding.readCopyDataPayload(lParam)` 解码回复载荷。
- `createWechatChatHistoryWinTransport()`：`process.platform === "win32" && mainWindow` 时才走原生 transport。
- 用途：与微信桌面端（目标 `targetHwnd`）走**自定义 WM_COPYDATA 协议**换取微信聊天记录 ZIP 路径（`win-chat-history-source.ts`）。

---

## 4. Electron 主可执行 `Contents/MacOS/Electron`

- `otool -L`：
  ```
  @rpath/Electron Framework.framework/Electron Framework
  /usr/lib/libSystem.B.dylib
  ```
  → 纯引导壳，业务逻辑全在 Framework。
- 主可执行本身 `strings` 无版本串（版本在 Framework 内：**37.10.3 / Chrome 138.0.7204.251**）。
- `codesign -dv`：
  ```
  Identifier   = com.workbuddy.workbuddy-ai
  Format       = app bundle with Mach-O thin (arm64)
  CodeDirectory flags=0x10000(runtime)   # hardened runtime
  TeamIdentifier = FN2V63AD2J
  Runtime Version = 15.4.0
  Sealed Resources version=2 rules=13 files=2624
  Timestamp    = Aug 24, 2026
  ```
  → 整体签名成 app bundle，非公证化出错的裸签名。`app_asar` 下 `package.json` 作者为 Tencent Technology (Shenzhen) Company Limited。

---

## 5. koffi FFI 调用点清单

koffi 在 `main/` 全树**只有一处 require**（`main/index.js:24571`），全部集中在 `createNativeCopyDataBinding(logger)`（region `wechat-chat-history/win-transport.ts`），且**仅 win32 生效**（非 win32 直接 `return`）：

| 位置 | 调用 |
|---|---|
| `main/index.js:24578` | `koffi.struct("COPYDATASTRUCT", { dwData:"uintptr_t", cbData:"uint32", lpData:"void *" })` |
| `main/index.js:24585` | `koffi.load("user32.dll")` |
| `main/index.js:24586` | `SendMessageTimeoutW(uintptr_t,uint32,uintptr_t,COPYDATASTRUCT *,uint32,uint32,uintptr_t *)`（`uintptr __stdcall`） |
| `main/index.js:24587` | `IsWindow(uintptr_t)`（`bool __stdcall`） |
| `main/index.js:24588` | `koffi.load("kernel32.dll")` |
| `main/index.js:24589` | `GetLastError()`（`uint32 __stdcall`） |

- 用途：向微信目标窗口 `targetHwnd` 发送 WM_COPYDATA（`dwData = 4034109776`），发送超时用 `SMTO_ABORTIFHUNG`；配合 `wechat-copydata-decoder` 解码微信回包。
- 绑定库：**`user32.dll`**（SendMessageTimeoutW / IsWindow）、**`kernel32.dll`**（GetLastError）。无其他外部 dylib/导出函数被 koffi 绑定。

---

## 6. 原生模块用途总表

| 模块 | 类型 | 平台 | 用途 | 调用/接入点 |
|---|---|---|---|---|
| `turing-sdk` (`turing_sdk.node`) | N-API 原生 addon（ObjC bundle） | darwin/win32（**macOS 运行时被代码禁用**） | 腾讯 T-Sec TuringShield 设备风险检测 + 设备指纹 + 反调试，产出 `X-Device-Token` | `main/index.js` `TuringSdkService`/`loadTuringNativeBinding`；`server.js:159317`、`tar.js:28194/28618` 注入请求头 |
| `wechat-copydata-decoder` | N-API 原生 addon | win32 only | 解码微信 `WM_COPYDATA` 载荷（`readCopyDataPayload(lParam)`） | `main/index.js` `NativeWechatWinCopyDataTransport`（`hookWindowMessage(74,…)`） |
| `@tencent/qimei-node` (`qimei.node` + `QimeiSDKMac.framework`) | N-API 原生 addon（optionalDependency `1.2.2`） | mac/win | 腾讯 QIMEI 设备指纹，产出 `qimei36` | `main/qimei-helper.js` `loadQimeiSdk()→require("@tencent/qimei-node/src/{mac,win}/index")`；`main/log-acl-guard.js` `QimeiDetectorImpl`（spawn helper 进程缓存 qimei36）；`main/module-base.js` `resolveQimeiDetector`；`main/daemon-app-server-main.js` `getQimei36`/`telemetry:updateQimei36` IPC |

> 补充：`@tencent/qimei-node` 本身也是原生模块（`node_modules/@tencent/qimei-node/build/Release/qimei.node` + `QimeiSDKMac.xcframework/macos-arm64_x86_64/QimeiSDKMac.framework`），与 turing_sdk 同为腾讯设备级 SDK，但用途区分：TuringShield 出 `X-Device-Token`（风控/安全），QIMEI 出 `qimei36`（广告/统计/设备识别）。

---

## 7. 发现的具体 URL / 域名

- **无**：turing_sdk 二进制无明文 host（见 2.7，[INFERENCE] 运行时加密解析）。
- 业务对外网络端点不在本切片边界内（由主会话统一汇总），本切片报告如下证据性标识：`RiskDetectServer.DeviceTokenV3`、`RiskDetectServer.SCGateway`、`MTMFShark.*`（TuringShield 协议），以及 qimei-helper 读取的 `WORKBUDDY_QIMEI_APP_KEY`/`WORKBUDDY_QIMEI_DLL_PATH` 环境变量。

## 8. 风险 / 后续

- TuringShield 收集 DeviceID（tracking=true）并访问 FileTimestamp/SystemBootTime/DiskSpace/UserDefaults，`PrivacyInfo.xcprivacy` 已声明，属合规声明。
- macOS 上 turing_sdk 被禁用但 native 仍随包分发、且签名 hardened runtime——如需收紧攻击面可考虑条件打包。
- koffi 仅 Windows 生效，但 `koffi` 仍出现在 `package.json` 依赖中（`^2.10.1`），Win 打包时才会真正加载。
