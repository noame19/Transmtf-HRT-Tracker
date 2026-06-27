# Transmtf-HRT-Tracker Android Debug APK 打包设计

**日期**：2026-06-27
**状态**：已批准，待实施
**目标仓库**：`D:\database\GitHub\Transmtf-HRT-Tracker`（git remote: `TransmtfTeam/Transmtf-HRT-Tracker`）

## 1. 背景

当前 `Transmtf-HRT-Tracker` 是基于 **Tauri 1.8** 的纯桌面端应用，从未配置 Android 构建。用户要求：
1. 打包 Android Debug APK
2. 目标 SDK = Android 12（`compileSdk = 31`）
3. UI / 交互 / 业务功能保持完全不变
4. **不在本地编译**，所有构建在 GitHub Actions 的 Ubuntu runner 上完成
5. 产物下载到本地 `D:\download\newnull\mtf-apk\`

## 2. 目标

完成 Tauri 1.x → 2.x 升级（Android 构建前置条件）+ 添加独立 Android 工作流，最终能在 GitHub Actions 上成功产出 Debug APK，并通过 `gh run download` 下载到本地。

## 3. 迁移评估（实测）

通过 read 代码确认（2026-06-27）：
- **`src-tauri/src/main.rs`**：仅 9 行，无自定义 invoke handler，仅 `tauri::Builder::default()` / `tauri::generate_handler![]` / `tauri::generate_context!()` 三个调用 → **Tauri 2.x 完全兼容**，**0 行 Rust 改动**
- **`src/` 前端**：grep `src/` 全文，**无任何 `@tauri-apps/api` import** → 前端是纯 React 应用，所有逻辑在 JS/TS → **0 行前端代码改动**
- **总改动**：仅 3 个配置文件版本号 + 1 个 workflow 文件 + 1 个 Android Gradle 子项目（自动生成）

## 4. 范围

### 4.1 改动文件

| 文件 | 改动类型 | 改动内容 |
|---|---|---|
| `src-tauri/Cargo.toml` | 版本升级 | `tauri = "^1.8"` → `^2`；`tauri-build = "^1.5"` → `^2`；移除 `shell-open` feature（v2 改用 `tauri-plugin-shell`，但当前未使用，不加） |
| `package.json` | 版本升级 | `@tauri-apps/cli = "^1.6.3"` → `^2` |
| `src-tauri/tauri.conf.json` | 配置重写 | schema 升 v2；移除 `allowlist`（v2 改用 capabilities）；`targets` 加 `"apk"`；新增 `bundle.android` 配置（compileSdk = 31）；移除 windows 配置或保留并加 android 兼容 |
| `.github/workflows/android-build.yml` | 新增 | 独立 Android 构建 workflow（见 §5） |

### 4.2 自动生成（不手写）

- `src-tauri/gen/android/`：通过 `npx @tauri-apps/cli@2 android init` 生成（Gradle 工程）。该命令**幂等**，第二次执行无副作用。该目录应加入 `.gitignore`（或在 commit 时排除），避免污染仓库。

### 4.3 不改动文件（明确边界）

- 桌面端 `.github/workflows/tauri-build.yml` —— 完全不动
- 所有 React 组件 / 路由 / 业务逻辑 / 算法 / DB / i18n / UI 色板 / DisclaimerModal
- `index.html`、`index.tsx`、`App.tsx`
- `vite.config.ts`、`vitest.config.ts`
- `personalModel.ts`、`pk.ts`、`mipd.ts`、`calibration.ts`、`logic.ts`、`types.ts`、`worker.ts`
- 全部 `src/`、`src-tauri/src/`、`docs/`、`scripts/`、`eval/`、`public/`、`icons/`
- `.env.example`、`.gitignore`、README、LICENSE、`Algorithm Explanation.md`、`TEMP_segment.txt`

### 4.4 配置版本对齐（GitHub Actions 上）

| 工具 | 版本 |
|---|---|
| Node.js | 20 |
| Rust toolchain | stable |
| JDK | 17（Gradle 要求） |
| Android compileSdk | 31 |
| Android targetSdk | 31 |
| Android minSdk | 24（Tauri 2.x Android 默认） |
| Android Build-Tools | 31.0.0 |
| Android NDK | 26.1.10909125 |
| Android Gradle Plugin | 由 `tauri android init` 生成的版本（无需手写） |
| Android Rust targets | aarch64-linux-android、armv7-linux-androideabi、x86_64-linux-android |
| Tauri CLI | 2.x（latest stable） |

## 5. 架构

### 5.1 触发条件

`.github/workflows/android-build.yml`：

```yaml
on:
  workflow_dispatch:        # 手动触发
  push:
    tags: ['v*.*.*']        # 发版时自动
```

### 5.2 Runner

`ubuntu-latest`（Tauri Android 官方推荐平台）

### 5.3 工作流步骤

1. `actions/checkout@v4` —— 拉代码
2. `actions/setup-node@v4` —— Node 20 + `cache: 'npm'`
3. `dtolnay/rust-toolchain@stable` + `target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android` —— 装 Rust + Android 三个 target
4. `actions/setup-java@v4` + `distribution: temurin` + `java-version: 17` —— 装 JDK 17
5. `android-actions/setup-android@v3` —— 装 Android SDK，含 `platforms;android-31`、`build-tools;31.0.0`、`ndk;26.1.10909125`、`cmdline-tools;latest`
6. `npm ci` —— 装前端依赖
7. `npx @tauri-apps/cli@2 android init --ci ${{ github.workspace }}/src-tauri` —— 生成/校验 Android Gradle 子项目
8. `cd src-tauri/gen/android && ./gradlew assembleDebug` —— 构建 Debug APK
9. `actions/upload-artifact@v4` —— name=`android-debug-apk`，path=`**/*.apk`

### 5.4 缓存策略

- `actions/setup-node` 自动缓存 `~/.npm`
- `actions/cache@v4` 缓存 `~/.gradle/caches` 和 `~/.gradle/wrapper`（key 含 `hashFiles('**/gradle-wrapper.properties')`）
- `actions/cache@v4` 缓存 `~/.cargo/registry`（key 含 Cargo.lock hash）

### 5.5 下载到本地

```bash
gh run download <run-id> -n android-debug-apk -D D:/download/newnull/mtf-apk
```

或 GitHub 网页 → Actions → Run → Artifacts → 下载 zip → 解压到 `D:\download\newnull\mtf-apk\`。

## 6. 数据流

```
本地代码 → git push → GitHub
  ↓
ubuntu-latest runner 触发 android-build.yml
  ↓
checkout → setup-node → setup-rust+android targets → setup-java → setup-android
  ↓
npm ci → tauri android init → gradlew assembleDebug
  ↓
APK 产物 → upload-artifact (android-debug-apk)
  ↓
用户：gh run download 或网页下载 → D:\download\newnull\mtf-apk\
  ↓
adb install 或手机文件管理器直装
```

## 7. 错误处理

- **构建失败**：通过 `gh run view <run-id> --log-failed` 看 Action 日志，定位失败步骤，按错误信息迭代修正（修改 Cargo.toml / tauri.conf.json / workflow），commit + push
- **本地不能预验证**：接受迭代成本。预计首次 2-4 轮 push 才能跑通
- **APK 安装失败**：debug APK 自带 debug.keystore；首次安装需要在 Android 手机开启"安装未知应用"权限

## 8. 测试

- **不在 CI 跑单元测试**（Android 构建不需要 vitest）
- **唯一验证信号**：GitHub Actions 构建成功 + artifact 包含 `.apk`
- 后续人工验收：手机装机、UI/交互对照原桌面版验证

## 9. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| Tauri 2.x 升级后 `tauri.conf.json` schema 变化 | 中 | 通过 `npx @tauri-apps/cli@2 android init --ci` 自动检测并提示 |
| 升级后前端 vite 构建产物路径与 Android webview 不兼容 | 低 | 前端无 Tauri API 调用，webview 加载 dist/ 应无变化 |
| Android SDK / NDK 下载慢 | 低 | 用 `android-actions/setup-android@v3` 预缓存 |
| Gradle 首次拉依赖慢 | 中 | 缓存 `~/.gradle/caches` |
| NDK 编译首次耗时（20-40 分钟） | 中 | 缓存 `~/.cargo/registry`；接受单次长耗时 |
| 缺少 Android mipmap 图标 | 低 | `tauri android init` 会生成默认图标；后续可手换 |
| `vite-plugin-pwa` + `cdn.tailwindcss.com` 在 Android webview 行为差异 | 低 | 不在本次范围内，发现问题再修 |

## 10. 验收标准

- [ ] `cargo metadata --manifest-path src-tauri/Cargo.toml` 在本地能解析（验证 Cargo.toml 正确）
- [ ] `npm install` 后 `npx tauri --version` 输出 2.x
- [ ] `.github/workflows/android-build.yml` 文件存在，trigger 配置正确
- [ ] push 到 GitHub 后能手动触发 workflow_dispatch
- [ ] workflow 最终产出 `android-debug-apk` artifact
- [ ] 至少有一个 `app-debug.apk` 在 artifact 内（`assembleDebug` 默认产物）
- [ ] 桌面端 `.github/workflows/tauri-build.yml` 在 push 后仍能正常产出 Windows MSI / macOS DMG（不被本次改动破坏）

## 11. 实施顺序概要

详细 plan 在 writing-plans 阶段产出。本 spec 只列顺序：

1. 修改 `src-tauri/Cargo.toml` 升 tauri 1→2
2. 修改 `package.json` 升 @tauri-apps/cli 1→2
3. 修改 `src-tauri/tauri.conf.json`（schema + targets + bundle.android + 移除 allowlist）
4. 创建 `.github/workflows/android-build.yml`
5. `git add` + `git commit`
6. `git push origin main`（注意：是 `TransmtfTeam/Transmtf-HRT-Tracker`，非 fork）
7. 在 GitHub 网页手动触发 workflow_dispatch（不必等 push tag）
8. `gh run watch <run-id>` 看日志迭代修正直到成功
9. `gh run download <run-id> -n android-debug-apk -D D:/download/newnull/mtf-apk`

## 12. 不在本次范围

- Android 签名 keystore 配置（debug 默认够用）
- Play Store 发布 / AAB 打包
- 桌面端工作流任何修改
- 前端 UI / 业务逻辑 / 算法任何调整
- iOS 构建
- 升级 Rust 工具链以外的工具

## 13. 关联项目状态

- 项目已本地 clone + 构建过 60MB debug APK（Tauri 1.x 时代）
- 用户已改过色板 / DisclaimerModal / 多语言 / 数据库层
- 上述改动均在源码层面，与本次 Android 打包独立