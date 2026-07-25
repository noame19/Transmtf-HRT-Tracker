# HRT Tracker

Web client of the HRT tracking tool. Simulates estradiol concentration over time from your body weight, height, and dosing route. All records stay in your browser's `localStorage`. This repository is a fork of [TransmtfTeam/Transmtf-HRT-Tracker](https://github.com/TransmtfTeam/Transmtf-HRT-Tracker). Chinese version: [README.md](./README.md).

> Distributed under the MIT License, see [`LICENSE`](./LICENSE). The fork-only changes since upstream are listed in the Chinese README's "本 fork 改了哪些东西" section. The original copyright notice is preserved in the LICENSE file.

## What it is

A React + TypeScript web tool for tracking HRT. You log doses (injection, oral, sublingual, gel, patch); the app draws an estradiol concentration curve over time using a pharmacokinetic model. You can also enter lab values and the app uses a Bayesian OU-Kalman model to fit your personal parameters. All data is stored in `localStorage`; nothing leaves your browser.

The PK formulas and parameters come from the upstream [HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test) repository (`PKcore.swift` / `PKparameter.swift`). That logic is unchanged in this fork.

## What this fork adds

A user-facing list of fork-only changes lives in the Chinese README's "本 fork 改了哪些东西" section. In short:

- A first-launch disclaimer dialog, with a re-open entry in Settings.
- A "Export for AI" entry in Settings with per-record body metrics, route-specific fields, and range-vs-total counts in the copied text.
- OIDC sign-in temporarily shows "pending development" instead of routing to the upstream auth server.
- Mobile Overview layout swapped between medication calendar and the estradiol chart; desktop unchanged.
- Batch-add UI reworked: patch path drops "times per day", removal hint shows the full date, preview apply time isn't pinned to 09:00.
- Patch pairing now uses strict `groupId` match instead of a 14-day timeline fallback.
- Tailwind moved off the Play CDN to local PostCSS.
- Settings and Account page credits now point at this fork's maintainer (noame19).

Full details in the Chinese README.

## Run locally

```bash
npm install
npm run dev
```

Tauri desktop / Android builds run on GitHub Actions.

## Deployment and license

You are welcome to host this app on your own site, blog, or server with no extra permission. If you do, please keep the link back to this repository and the MIT License (see [LICENSE](./LICENSE)).

## Repo

Please file issues on GitHub: <https://github.com/noame19/Transmtf-HRT-Tracker/issues>.
