# AGENTS.md

给在这个仓库里写代码的 AI / 新人的一页说明。读它比读 40 个组件快。

## 这是什么

HRT Tracker —— 激素替代疗法（HRT）的用药记录与血药浓度模拟工具。
React + TypeScript + Vite，桌面/安卓壳是 Tauri 2，可选的云同步跑在 Cloudflare Worker 上。

**全部数据默认只存在浏览器 `localStorage` 里**，离线可用。涉及用户健康的数值，
宁可不显示，也不要猜一个看似合理的值（历史教训见「数据完整性」一节）。

## 目录

```
src/
  main.tsx            应用入口（index.html 的 <script> 指向这里）
  App.tsx             路由与 Provider 挂载
  constants.ts        跨模块常量
  worker.ts           Cloudflare Worker（HTMLRewriter 注入 runtime env）
  lib/                纯领域层，无 React 依赖，可被 worker / node 直接跑
    types.ts            DoseEvent / Plan / LabResult / Route / Ester / ExtraKey
    pk.ts               药代动力学核心：resolveParams + runSimulation + 各途径吸收模型
    calibration.ts      用化验结果反推个人参数（贝叶斯 MAP + 单维网格细化）
    mipd.ts             多剂量叠加 + MAP 个体化预测
    personalModel.ts    个人模型封装（把 calibration/mipd 的结果喂给 pk）
    logic.ts            领域层 barrel，只做 re-export
    pk.test.ts / mipd.test.ts
  components/         UI 组件（40 个，平铺，不分子目录——除了 ui/ 基础件）
    ui/                 通用小件：Badge / Button / Card / Modal / TabBar / Toggle
  views/              页面级视图（OverviewView / HistoryView / LabView）
  pages/              路由包装层（Page = View + 数据注入）
  contexts/           AppDataContext（全局状态）+ Auth/CloudSync/Theme/Language/Dialog/SecurityPassword
  utils/              纯函数工具，绝大多数有同名 .test.ts
  hooks/              useConfirmButton / useFocusTrap 等
  i18n/translations.ts  四语言字典（zh / zh-TW / en / ja），186K 单文件
src-tauri/
  src/lib.rs          Rust 侧：JNI shim + 命令注册 + 文件导出
  scripts/*.kt        Android 桥接类，由 CI 整包拷进生成的 Android 工程
    NotificationScheduler.kt   用药提醒的 AlarmManager 调度（**与 TS 的调度逻辑必须保持一致**）
    ReminderReceiver.kt        闹钟触发 → 通知栏动作
eval/                 离线的算法评估脚手架（syntheticEval + leave-one-lab-out benchmark）
doc/                  算法说明（Algorithm Explanation.md）
scripts/set_version.py 改版本号（package.json + tauri.conf.json + Cargo.toml 三处）
```

## 跑起来

```bash
npm install
npm run dev        # vite，端口 3000
npm test           # vitest run（25 个测试文件）
npm run typecheck  # tsc --noEmit（**尚未接入 CI，见下**）
```

本地开发需要 Node 22。桌面/安卓打包需要 Rust + Android SDK，本地一般不需要碰。

## CI 怎么跑（重要）

三个 workflow 都是**手动触发**（`workflow_dispatch`）：

| workflow | 干什么 |
|---|---|
| `android-debug.yml` | debug APK |
| `android-release.yml` | 签名 release APK |
| `tauri-build.yml` | Windows / macOS 桌面（tag `v*.*.*` 也会触发） |

它们只做 `npm ci && npm run build`，**没有 `tsc --noEmit`，也没有 `npm test`**。
这带来一个真实的坑：只在类型位置出现的坏 import 会被 esbuild 整条擦除，
`vite build` 依旧绿，错误一直潜伏到运行时才炸（`LabResultModal` 的 `'../logic'`
就是这么藏了几个月）。所以：

- 动了 import 路径，一定要自己搜一遍有没有漏。
- 想加 typecheck / test 到 CI 是欢迎的，但要先确认仓库当前能过——历史遗留的
  类型错误可能不少，直接接进 `npm run build` 会把云编译搞红。

## 数据完整性：这个仓库最容易被改坏的地方

用户灌进去的是几个月的用药记录，一旦被静默改写就没法追溯。已有代码里
踩过的坑，改相关代码时请守住：

- **「没记录」和「记录了一个默认值」必须可区分。** 身高曾经被 import 时
  一律写成 fallback（`prefillHeightCM` 兜底 160），于是「从没量过」和
  「量出来正好 160」在数据里长得一样。现在缺失就留 `undefined`，回填走
  `backfillEventHeights()` 的「最近实测值」策略，等距取更早的那个
  （理由：身高增长不该回头改写旧记录）。
- **非表单写入路径统一走 `resolveBodyStats(events)`。** 计划一键确认、提醒
  确认、批量确认、摘下贴片——这些地方曾经只有 `weightKG`、没有 `heightCm`。
  新增任何「程序化创建 DoseEvent」的位置，记得把身高一起带上。
- **迁移函数要幂等、不改输入、没有缺口时返回原对象引用**（方便跳过
  localStorage 写入）。参考 `src/utils/weight.ts` 的 `backfillEventHeights`。
- **导入解析不能编数据。** `importData.ts` 的 `fallbackHeight` 现在是可选的：
  没传就真的不写字段；传了也要过 50–250 的范围校验。

## 计划调度：TS 与 Kotlin 必须同步

`src/utils/planSchedule.ts` 和 `src-tauri/scripts/NotificationScheduler.kt`
是同一套调度规则的两份实现（前者决定 App 内显示，后者决定系统闹钟）。
改任何一边都要改另一边，否则「App 说该吃了但通知不来」或反过来。

已经踩过的不对称点：
- `intervalDays` 曾经两边都是整数（TS 用 `Math.round` + 取模，Kotlin 用 `Int` +
  `optInt`），小数周期会被静默取整。现在两边都是 `Double` + 浮点比较。
- `timesByWeekday`（每周各天独立时间）是**可选叠加层**：字段缺失 = 所有星期
  共用 `times`，所以旧数据零迁移。Kotlin 侧 `ParsedPlan.timesByWeekday` 同理。
- `validatePlan()` 的 dose 规则：贴片计划允许 `doseMG === 0`，只要
  `extras.releaseRateUGPerDay > 0`（用 `isRateOnlyPlan()` 判断）。展示时用
  `formatPlanDose()`，不要直接拼 `plan.doseMG`，否则会出现「剂量 0 mg」。

## 贴片（patch）的两个特殊之处

1. **贴上/撕下靠 `companionGroupId` 严格配对**，不做时间轴兜底 —— 曾经用
   「14 天内最近的撕下」自动配对，结果把不同周期的两组贴片错配。相关工具在
   `src/utils/patch.ts`，孤儿清理在 `src/utils/patchReconcile.ts`
   （注意：目前只在 import 时跑一次）。
2. **可以只填释放速率**。此时 `doseMG = 0` 是设计意图，PK 层（`pk.ts` 的
   `resolveParams`）会改用 `rateMGh = releaseRateUGPerDay / 24 / 1000 * F`。
   不要「顺手」给这种记录补一个非零 `doseMG`。

## 代码约定

- **i18n 必须四语齐全**：`translations.ts` 是 `zh / zh-TW / en / ja` 四份平铺
  字典，key 按字母序靠在一起。新增 key 时四份都要加，插在相邻 key 之后。
  取用一律 `t('some.key')`，取不到会回落成 key 本身。
- **样式用 CSS 变量，不硬编码颜色**：`var(--text-primary)` /
  `var(--bg-card-hover)` / `var(--border-primary)` 等，暗色模式才能生效。
- **响应式优先考虑 360dp**：安卓手机常见宽度。一排塞三个东西时用
  `flex-wrap` 或 `hidden sm:inline`，别指望 `shrink-0` 能救。
  （「贴片摘下」按钮曾经把整行挤扁就是这个教训。）
- **注释写「为什么」，不写「做了什么」**。仓库里已有的注释基本都在解释
  某个看起来奇怪的写法是为了避开什么 bug —— 保持这个风格。

## 提交与版本

- 一个改动一个 commit，方便回溯、方便回滚。
- commit message 用中文，`type(scope): 简述`，正文说明**动机**和**验证方式**。
- 版本号统一用 `python3 scripts/set_version.py <version> [--build]`，它会同时
  改 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。
- `android-release.yml` 的 tag 触发器目前是注释掉的，别顺手打开。

## 别做的事

- 别把 `src/lib/` 里的纯领域模块 import 到 worker 之外需要 DOM 的地方
  （它们本身没有 DOM 依赖，反向依赖会破坏 node 环境跑测试的能力）。
- 别在 `pk.ts` / `calibration.ts` 里改动算法常数，除非用户明确要求 ——
  这些参数对应上游 `PKcore.swift`，改了就和其他实现不可比。
- 别删 `src-tauri/scripts/*.kt` 里「看起来没人调用」的类：CI 是整包 `cp`，
  少一个类就是在 APK 里少一个 JNI 目标，运行时才 `ClassNotFoundException`。
- 别把 `.worktrees/` 加进 tailwind 的 content 扫描（会产出重复 utility）。
