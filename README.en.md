# HRT Tracker

HRT Tracker is a web tool for tracking hormone replacement therapy. It simulates estradiol concentration over time from body weight, height, and dosing route, and fits per-user metabolic parameters from lab values. All data is stored in the browser's `localStorage` — nothing is uploaded, no network requests leave the device.

Chinese version: [README.md](./README.md)

> This repository is a fork of [TransmtfTeam/Transmtf-HRT-Tracker](https://github.com/TransmtfTeam/Transmtf-HRT-Tracker), still under the MIT License (see [`LICENSE`](./LICENSE)). The original copyright notice is preserved in that file.

## Features

- **Multi-route simulation**: injection (valerate, benzoate, cypionate, enanthate), oral, sublingual, gel, and patch.
- **Real-time estradiol curve**: an interactive chart showing concentration (pg/mL) over time.
- **Sublingual guidance**: concrete recommendations for hold time and the absorption parameter θ.
- **Personal metabolic fit**: a Bayesian OU-Kalman model fits per-user metabolic parameters once lab values are entered.
- **Multiple languages**: Simplified Chinese, Traditional Chinese, English, Cantonese, Russian, Ukrainian, and more.
- **Fully local storage**: every record lives in browser `localStorage`. Survives reloads and offline use.
- **First-launch disclaimer and an AI-consultation export**: a disclaimer dialog shows on first launch; a Settings entry exports a self-contained text snapshot of dosing records and lab values for a chosen date range.

## Upstream algorithm

The pharmacokinetic formulas and parameters are derived from the [HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test) repository (`PKcore.swift`, `PKparameter.swift`). This logic is unchanged in the fork.

## Run locally

```bash
npm install
npm run dev
```

Desktop and Android builds run on GitHub Actions. `tauri:dev` and `tauri:build` on a local machine require Rust and the Android SDK.

## Deployment

The app can be self-hosted on any personal site, blog, or server without further permission. For public deployments, please keep a link back to this repository and the MIT License (see [`LICENSE`](./LICENSE)).

## Feedback

Open an issue on the GitHub repository page.
