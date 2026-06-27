# Transmtf-HRT-Tracker Android Debug APK Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Tauri 1.8 桌面项目升级到 Tauri 2.x 并添加 GitHub Actions Android Debug APK 构建流，最终在 Ubuntu runner 上产出可下载的 debug APK。

**Architecture:** 最小侵入式 Tauri 1→2 升级（main.rs API 兼容、零前端代码改动），配合独立 Android workflow（ubuntu-latest + JDK17 + Android SDK 31 + NDK 26 + gradlew assembleDebug），通过 `tauri android init` 自动生成 Gradle 子项目。

**Tech Stack:** Tauri 2.x、@tauri-apps/cli 2.x、Node 20、Rust stable + Android targets、JDK 17、Android SDK 31、Android Build-Tools 31.0.0、Android NDK 26.1.10909125、Gradle (由 init 生成)、GitHub Actions ubuntu-latest。

---

## Working Directory

所有 git 操作在 `D:/database/GitHub/Transmtf-HRT-Tracker/` 进行（cwd 自动重置回 `D:\download\newnull`，每个 git 命令前需 `cd`）。

Git remote：`https://github.com/TransmtfTeam/Transmtf-HRT-Tracker.git`

---

## Task 1: 升级 `src-tauri/Cargo.toml` 到 Tauri 2.x

**Files:**
- Modify: `D:/database/GitHub/Transmtf-HRT-Tracker/src-tauri/Cargo.toml:1-26`

**Context:** 当前文件锁定 Tauri 1.x。需要升 `tauri = "^1.8"` → `^2`、`tauri-build = "^1.5"` → `^2`，并移除 `shell-open` feature（v2 不存在；当前代码未使用该 feature）。

- [ ] **Step 1: 备份当前依赖快照**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
cp src-tauri/Cargo.toml src-tauri/Cargo.toml.bak
```

- [ ] **Step 2: 改 `tauri-build` 版本**

把第 11 行：
```toml
tauri-build = { version = "^1.5", features = [] }
```
改成：
```toml
tauri-build = { version = "^2", features = [] }
```

- [ ] **Step 3: 改 `tauri` 版本和移除 `shell-open`**

把第 16 行：
```toml
tauri = { version = "^1.8", features = ["shell-open"] }
```
改成：
```toml
tauri = { version = "^2", features = [] }
```

- [ ] **Step 4: 确认 `[features]` 节不动**

第 18-20 行 `[features] default = ["custom-protocol"] / custom-protocol = ["tauri/custom-protocol"]` 在 Tauri 2.x 仍兼容，先保留。如果后面 workflow 报错再调整。

- [ ] **Step 5: 本地快速解析校验（仅元数据查询，不编译）**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 > /tmp/cargo-meta.json 2>&1
```

Expected：输出 JSON，无 "error" 字样。如果有 "failed to parse" 或 "feature not found"，说明版本号写错，回 Step 2 改。

- [ ] **Step 6: 删备份**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
rm src-tauri/Cargo.toml.bak
```

- [ ] **Step 7: 不 commit（统一到最后 commit）**

Task 1 不单独 commit。Task 1-5 改动在 Task 7 一起 commit。

---

## Task 2: 升级 `package.json` 的 `@tauri-apps/cli`

**Files:**
- Modify: `D:/database/GitHub/Transmtf-HRT-Tracker/package.json:33`（`@tauri-apps/cli` 行）

- [ ] **Step 1: 改 `@tauri-apps/cli` 版本**

把第 33 行：
```json
"@tauri-apps/cli": "^1.6.3",
```
改成：
```json
"@tauri-apps/cli": "^2",
```

- [ ] **Step 2: 验证 JSON 解析**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo "JSON OK"
```

Expected：输出 `JSON OK`。如果报 `SyntaxError`，检查逗号、引号。

- [ ] **Step 3: 不 commit**

Task 2 不单独 commit。

---

## Task 3: 重写 `src-tauri/tauri.conf.json` 为 Tauri 2.x schema

**Files:**
- Modify: `D:/database/GitHub/Transmtf-HRT-Tracker/src-tauri/tauri.conf.json:1-56`（整文件重写）

**Context:** Tauri 2.x `tauri.conf.json` 顶层结构变化：
- `$schema` 改 v2
- `tauri.windows` 仍兼容，但 v2 也支持 `app.windows`
- `tauri.allowlist` **完全删除**（v2 改用 capabilities 文件，本次不配置权限——main.rs 无任何 command 调用，默认应用不需要额外权限）
- `tauri.bundle.targets` 加 `"apk"`
- 新增 `bundle.android` 配置 `compileSdkVersion = 31`
- 桌面 targets（dmg/app/msi）保留以兼容现有 workflow

- [ ] **Step 1: 备份**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
cp src-tauri/tauri.conf.json src-tauri/tauri.conf.json.bak
```

- [ ] **Step 2: 整文件重写为以下内容**

把 `src-tauri/tauri.conf.json` **整个文件**替换为：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Transmtf HRT Tracker",
  "version": "1.3.0",
  "identifier": "com.smirnovayama.hrttracker",
  "build": {
    "beforeDevCommand": "npm run dev -- --host",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Transmtf HRT Tracker",
        "width": 1000,
        "height": 800,
        "minWidth": 420,
        "minHeight": 700,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "app", "msi", "apk"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "android": {
      "minSdkVersion": 24
    }
  },
  "plugins": {}
}
```

说明：
- `devPath` 和 `distDir` 删了（v2 自动推断，对应 `build.frontendDist` 默认 `../dist`）
- `updater` 删了（v2 需要单独配 plugin，本次不启用）
- `allowlist` 完全删了
- `compileSdkVersion` 不在 `bundle.android` 里——它在生成的 Gradle 子项目的 `build.gradle` 里，由 `tauri android init` 自动设为 31（来自 CLI 当前默认）。
- 移动端 compileSdk 的精确控制**通过 `tauri.conf.json` 不直接暴露**，需要 init 后修改 `src-tauri/gen/android/build.gradle`（Task 5 Step 6 详述）。

- [ ] **Step 3: JSON 验证**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8'))" && echo "JSON OK"
```

Expected：输出 `JSON OK`。

- [ ] **Step 4: 删备份**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
rm src-tauri/tauri.conf.json.bak
```

- [ ] **Step 5: 不 commit**

Task 3 不单独 commit。

---

## Task 4: 更新 `.gitignore` 忽略自动生成的 Android 子项目

**Files:**
- Modify: `D:/database/GitHub/Transmtf-HRT-Tracker/.gitignore:11-15`

**Context:** `src-tauri/gen/android/` 由 `tauri android init` 在 CI 上每次生成，无需 commit 到仓库。

- [ ] **Step 1: 在 `.gitignore` 中 `src-tauri/target` 行后追加**

把第 12-13 行：
```
node_modules
dist
dist-ssr
src-tauri/target
```
改成：
```
node_modules
dist
dist-ssr
src-tauri/target
src-tauri/gen
```

- [ ] **Step 2: 验证 git 状态确认不会被误 commit**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
git check-ignore -v src-tauri/gen/android/build.gradle 2>&1 || echo "NOT IGNORED"
```

Expected：输出包含 `src-tauri/gen` 路径。如果输出 `NOT IGNORED`，回 Step 1 检查拼写。

- [ ] **Step 3: 不 commit**

---

## Task 5: 创建 `.github/workflows/android-build.yml`

**Files:**
- Create: `D:/database/GitHub/Transmtf-HRT-Tracker/.github/workflows/android-build.yml`

- [ ] **Step 1: 创建文件**

写入 `D:/database/GitHub/Transmtf-HRT-Tracker/.github/workflows/android-build.yml` 的完整内容：

```yaml
name: Android Debug APK

on:
  workflow_dispatch:
  push:
    tags:
      - "v*.*.*"

jobs:
  build-android-debug:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Add Android Rust targets
        run: |
          rustup target add aarch64-linux-android
          rustup target add armv7-linux-androideabi
          rustup target add x86_64-linux-android

      - name: Setup JDK 17
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3
        with:
          cmdline-tools-version: '11076708'
          packages: 'platform-tools,platforms;android-31,build-tools;31.0.0,ndk;26.1.10909125'
          cache-packages: true

      - name: Cache Gradle
        uses: actions/cache@v4
        with:
          path: |
            ~/.gradle/caches
            ~/.gradle/wrapper
          key: gradle-${{ runner.os }}-${{ hashFiles('src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties') }}
          restore-keys: |
            gradle-${{ runner.os }}-

      - name: Cache Cargo registry
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
          key: cargo-${{ runner.os }}-${{ hashFiles('src-tauri/Cargo.lock') }}
          restore-keys: |
            cargo-${{ runner.os }}-

      - name: Install npm dependencies
        run: npm ci

      - name: Generate Android project (idempotent)
        run: npx @tauri-apps/cli@2 android init --ci src-tauri

      - name: Pin compileSdk to 31 in generated project
        run: |
          set -e
          GRADLE=src-tauri/gen/android/build.gradle
          if [ ! -f "$GRADLE" ]; then
            echo "::error::Expected $GRADLE after init"
            exit 1
          fi
          echo "--- before ---"
          grep -nE 'compileSdk|targetSdk|minSdk' "$GRADLE" || true
          sed -i -E 's/(compileSdk[[:space:]]+)[0-9]+/\131/' "$GRADLE"
          sed -i -E 's/(targetSdk[[:space:]]+)[0-9]+/\131/' "$GRADLE"
          echo "--- after ---"
          grep -nE 'compileSdk|targetSdk|minSdk' "$GRADLE"

      - name: Build Debug APK
        run: cd src-tauri/gen/android && ./gradlew assembleDebug --no-daemon

      - name: Locate APK
        id: locate
        run: |
          APK=$(find src-tauri/gen/android -name "*.apk" -type f | head -n 1)
          if [ -z "$APK" ]; then
            echo "::error::No APK found"
            exit 1
          fi
          echo "apk_path=$APK" >> $GITHUB_OUTPUT
          echo "APK at: $APK"
          ls -la "$APK"

      - name: Upload APK artifact
        uses: actions/upload-artifact@v4
        with:
          name: android-debug-apk
          path: ${{ steps.locate.outputs.apk_path }}
          if-no-files-found: error
```

- [ ] **Step 2: YAML 验证**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
node -e "const yaml=require('js-yaml');console.log(yaml.load(require('fs').readFileSync('.github/workflows/android-build.yml','utf8')).name)" 2>&1 || \
python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/android-build.yml'));print('YAML OK')"
```

Expected：第一个命令输出 `Android Debug APK`，或第二个输出 `YAML OK`。两个都失败说明 YAML 缩进有问题。

- [ ] **Step 3: 不 commit**

---

## Task 6: 一次性提交所有改动 + push

**Files:**
- Stage all: Cargo.toml, package.json, tauri.conf.json, .gitignore, .github/workflows/android-build.yml

- [ ] **Step 1: 检查 git 状态确认**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
git status
```

Expected：`src-tauri/Cargo.toml`、`package.json`、`src-tauri/tauri.conf.json`、`.gitignore`、`.github/workflows/android-build.yml` 都列在 `Changes not staged for commit`，**不**应包含 `src-tauri/gen/android/` 或 `src-tauri/target/`。

- [ ] **Step 2: 检查 diff 概览**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
git diff --stat
```

Expected：5 个文件改动（上面列的），不应看到 Cargo.lock 大幅变化（如果 Cargo.lock 因为 ta 去到 2.x 也变了，OK）。

- [ ] **Step 3: Stage + commit**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
git add src-tauri/Cargo.toml package.json src-tauri/tauri.conf.json .gitignore .github/workflows/android-build.yml
git commit -m "$(cat <<'EOF'
build: upgrade Tauri 1.8 → 2.x and add Android Debug APK workflow

- Cargo.toml: tauri ^1.8 → ^2, drop shell-open feature
- package.json: @tauri-apps/cli ^1.6.3 → ^2
- tauri.conf.json: migrate to v2 schema, add apk target,
  remove allowlist (replaced by capabilities in v2)
- .gitignore: ignore src-tauri/gen/ (generated by tauri android init)
- .github/workflows/android-build.yml: new CI flow for debug APK

UI / business logic / desktop workflow intentionally untouched.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

Expected：commit 成功，hash 输出形如 `[main abc1234] build: ...`。

- [ ] **Step 4: Push 到远程**

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
git push origin main
```

Expected：`To https://github.com/TransmtfTeam/Transmtf-HRT-Tracker.git` + `main -> main`。如果报 `permission denied` 或 `authentication failed`，需要用户配置 git 凭据（gh auth login 或 git credential helper）。

---

## Task 7: 触发 workflow 并解析日志

**Files:** 无文件改动，纯验证步骤。

**Context:** 本地不能 build，唯一验证信号是 GitHub Actions 日志。失败大概率首次，需要迭代修正。

- [ ] **Step 1: 通过 gh CLI 触发 workflow_dispatch**

```bash
gh workflow run android-build.yml --repo TransmtfTeam/Transmtf-HRT-Tracker
```

Expected：`✓ Created workflow dispatch event: ...` 加一个 URL。如果 `gh` 未认证，先 `gh auth login`。

- [ ] **Step 2: 列出 runs 找到刚触发的 run ID**

```bash
gh run list --workflow=android-build.yml --repo TransmtfTeam/Transmtf-HRT-Tracker --limit 1
```

Expected：输出表格，第一列是 run ID（数字），第二列是状态（`in_progress` / `completed`）。

- [ ] **Step 3: 实时跟踪运行**

```bash
gh run watch <RUN_ID> --repo TransmtfTeam/Transmtf-HRT-Tracker --exit-status
```

Expected：
- 成功：`✓ Run <RUN_ID> completed with conclusion success`
- 失败：`X Run <RUN_ID> failed`（exit code 非 0）

记录实际 run ID 备用。

- [ ] **Step 4: 如果失败，查看失败日志**

```bash
gh run view <RUN_ID> --repo TransmtfTeam/Transmtf-HRT-Tracker --log-failed
```

Expected：失败步骤的日志输出。重点看 ERROR 行的栈信息。

- [ ] **Step 5: 常见失败及修复**

| 失败信号 | 修复 |
|---|---|
| `error: package ID specification 'tauri' did not match any packages` | Cargo.toml 没正确升 2.x，回 Task 1 |
| `error[E0xxx]: use of undeclared crate or module 'tauri'` | tauri.conf.json schema 没改对，回 Task 3 |
| `Could not find tools.jar` | JDK 没装好，回 Task 5 确认 setup-java 步骤 |
| `SDK location not found` | ANDROID_HOME 没设，回 Task 5 确认 setup-android |
| `compileSdkVersion 32 not found`（或其他非 31） | `tauri android init` 默认 compileSdk 不一定是 31，需手动改 `src-tauri/gen/android/build.gradle`（在 workflow 的 "Pin compileSdk to 31" 步骤里 sed 已经处理；如果还失败，检查 sed 是否真的跑了） |
| `gradlew: Permission denied` | workflow 加 `chmod +x src-tauri/gen/android/gradlew` 步骤 |
| `error: linking with 'cc' failed` | 缺 Android NDK 链接器，确认 `ndk;26.1.10909125` 已装 |
| `target not found: aarch64-linux-android` | 确认 Task 5 "Add Android Rust targets" 步骤 |
| `Failed to find target with hash string 'android-XX'` 或 `compileSdk ... not found` | `tauri android init` 默认 compileSdk 不是 31；检查 Task 5 "Pin compileSdk to 31" sed 是否生效 |
| npm ci 报错 `ERESOLVE` | package.json `^2` 解析到了不兼容版本；改 `^2.0.0` 或 `^2.1.0` 固定到具体大版本 |
| `dl.google.com/android/repository/...ndk... 404` | NDK 版本号失效；查 [NDK 版本列表](https://developer.android.com/ndk/downloads) 替换 `ndk;26.1.10909125` |
| `Gradle could not find tool 'aapt2'` | build-tools 没装好；确认 `build-tools;31.0.0` 在 setup-android 的 packages 里 |

- [ ] **Step 6: 修改后重新 commit + push + 重新触发**

每次修复后：

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
# 编辑对应的文件（修）
git add <修过的文件>
git commit -m "fix(android-build): <具体错误简述>"
git push origin main
gh workflow run android-build.yml --repo TransmtfTeam/Transmtf-HRT-Tracker
```

**接受 2-4 轮迭代直到成功**（用户已确认）。

- [ ] **Step 7: 成功后确认 artifact 存在**

```bash
gh run view <RUN_ID> --repo TransmtfTeam/Transmtf-HRT-Tracker --json artifacts --jq '.artifacts[] | {name, sizeInBytes}'
```

Expected：包含 `{"name":"android-debug-apk","sizeInBytes":<数字>}`（一般 50-80 MB）。

---

## Task 8: 下载 APK 到本地

**Files:** 无。

- [ ] **Step 1: 创建目标目录**

```bash
mkdir -p D:/download/newnull/mtf-apk
```

- [ ] **Step 2: 下载 artifact**

```bash
gh run download <RUN_ID> --repo TransmtfTeam/Transmtf-HRT-Tracker --name android-debug-apk --dir D:/download/newnull/mtf-apk
```

Expected：输出 `Downloading android-debug-apk... ✓`，目标目录出现 APK 文件。

- [ ] **Step 3: 验证**

```bash
ls -la D:/download/newnull/mtf-apk/
```

Expected：至少一个 `*.apk` 文件（典型名 `app-debug.apk`）。

- [ ] **Step 4: 打印 SHA256 用于校验**

```bash
sha256sum D:/download/newnull/mtf-apk/*.apk
```

Expected：输出 hash 字符串。

---

## Task 9: 验收

- [ ] **Step 1: APK 文件存在**

```bash
test -f D:/download/newnull/mtf-apk/app-debug.apk && echo "APK EXISTS" || ls D:/download/newnull/mtf-apk/
```

Expected：输出 `APK EXISTS` 或列出 APK 文件名。

- [ ] **Step 2: 报告给用户**

告知：
- APK 路径：`D:\download\newnull\mtf-apk\app-debug.apk`
- 大小（MB）
- SHA256
- 安装方式：`adb install app-debug.apk` 或拷到手机文件管理器点击安装（需开启"安装未知应用"）

---

## 附录 A：回滚计划

如果遇到无法解决的 blocker 需要回滚到 Tauri 1.x：

```bash
cd D:/database/GitHub/Transmtf-HRT-Tracker
git revert HEAD~1..HEAD --no-edit
git push origin main
```

然后删除 `.github/workflows/android-build.yml`。

---

## 附录 B：未在本次范围

- iOS 构建（需要 macOS runner）
- Release APK 签名（需要 keystore secrets）
- Play Store 发布（AAB + 签名 + 上架）
- 桌面端 workflow 修改
- 前端 UI / 业务逻辑任何改动
- Rust 工具链以外的工具升级