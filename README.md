# PrizePicks Ledger

A personal bet tracker that installs on your phone like an app: balance, PnL, open risk, edge vs break-even and every entry. Not affiliated with PrizePicks.

## Install

- **iPhone:** open the site in Safari, tap Share, then Add to Home Screen.
- **Android:** open it in Chrome and tap Install app (or menu → Add to Home screen).

It opens full screen, works offline and syncs between devices.

## How it syncs

Your bets are not in this repo. They live in `ledger.json` in your private data repo. The first time you open the app on a device, paste a fine-grained GitHub token that can read and write that repo's contents. The token stays on that device.

- Every change is a commit to the data repo, so its history keeps every version.
- Offline changes wait on the device and sync when you're back online.
- If two devices (or Claude) save at the same moment, the app reloads the newer copy and re-applies your change.

## Files

- `index.html`: the whole app
- `config.js`: which data repo the app suggests on first launch
- `sw.js`: offline support
- `manifest.webmanifest`, `icons/`: app name and icon
