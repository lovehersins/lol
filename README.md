# App Starter

Electron starter app: a dark-themed UI with a Settings panel for a base URL,
endpoint, and API key, plus a console that sends prompts to that API and
shows the response. Wire in your real API whenever you get it — nothing
about the request logic is hardcoded to a specific provider.

## Run it locally

```bash
npm install
npm start
```

## Set your API details

Open the app and fill in **Base URL**, **Endpoint**, and **API key** in the
left panel, then **Save settings**. These are stored locally in your OS user
data folder (not in this repo, not in the built exe) so your key never gets
committed or shipped.

If you'd rather pre-fill defaults for local dev, copy `.env.example` to
`.env` and fill it in — `.env` is git-ignored.

## Build the Windows .exe

Locally (on Windows, or via Wine on Linux/macOS):

```bash
npm run dist
```

The installer lands in `dist/`.

### Or let GitHub build it for you

This repo includes `.github/workflows/build.yml`, which builds the exe on
every push to `main` using a Windows GitHub Actions runner. After a push,
go to **Actions → Build Windows exe → latest run → Artifacts** and download
`app-starter-windows`.

## Project layout

```
src/
  main.js           Electron main process, config storage, API calls
  preload.js         Safe bridge between renderer and main
  renderer/          UI (HTML/CSS/JS)
.github/workflows/   CI build for the .exe
```

## Where to plug in your API logic

The actual request happens in `src/main.js`, in the `api:call` handler. Right
now it POSTs `{ prompt }` as JSON with a `Bearer` auth header — adjust the
request shape, headers, or response parsing there once you know your API's
real contract.
