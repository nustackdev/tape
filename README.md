# tape

Record a websocket UI session, replay it anywhere.

Tape puts a proxy in front of a running app, logs what the server sends over its sockets plus what the pointer does, and writes it all to one `scene.json`. The player then runs the real app bundle in an iframe with `window.WebSocket` swapped for a fake that replays the scene, a cursor drawn on top. No screenshots, no video: the app on the page is the real one.

Works for any UI driven by a websocket. Frames are opaque bytes, tape never reads them.

## Packages

| package | what |
| --- | --- |
| `@nustackdev/tape` | the `tape` CLI: record, bundle, trim, info |
| `@nustackdev/tape-player` | `<LiveScene>` (react) and the shim that runs inside the iframe |
| `@nustackdev/tape-scene` | the scene format and its helpers |

## Install

```bash
npm i -D @nustackdev/tape          # the CLI
npm i @nustackdev/tape-player      # <LiveScene>
```

## Record

```bash
tape record http://127.0.0.1:8080 -o hero.json
```

Open the printed url, click around, ctrl+c to save. A reload starts a new take. Then cut it:

```bash
tape info hero.json
tape trim hero.json --start 1.2 --end 14
```

Everything before `--start` still plays, instantly, so the scene opens on the state it had at that moment.

## Bundle

The player needs the app's build with the shim in front of it:

```bash
tape bundle path/to/dist -o public/scenes/app --base /scenes/app/
```

This copies the build, points its root absolute urls under `--base` (html, css, vite's preload helper) and makes its module scripts inert, so the shim can start them once the scene is in. The app's source is never touched.

## Play

```tsx
import { LiveScene } from "@nustackdev/tape-player";

<LiveScene app="/scenes/app/index.html" scene="/scenes/hero.json" aspect={16 / 10} />
```

The frame has a fixed aspect, empty until the replay is on screen, so nothing shifts. It loads after first paint and only near the viewport, plays in view, pauses off screen, loops. With `prefers-reduced-motion` it shows the last frame, still. The app renders at the recorded viewport size and is scaled to fit.

The cursor and the click ripple are yours to draw: `cursor` takes a node, drawn with its top left on the pointer tip, its box marked `data-down="1"` while pressed; `click` takes a node drawn centred on each click for `clickMs`, animated with your CSS. `cursor={false}` and `click={null}` turn them off.

```tsx
<LiveScene app={app} scene={scene} cursor={<MyCursor />} click={<MyClick />} clickMs={480} />
```

## What replays

- every server frame, on its recorded time, per socket. sockets are matched by url in open order, so a reconnect in the take replays as one
- the input, as DOM events fed into the app: clicks, keys, drags, scrolls. so local UI plays too: menus open, fields fill, hover buttons show
- client side navigation, as a fallback when the replayed click didn't cause it
- localStorage at load, as a private copy
- the pointer, as a drawn cursor with click ripples

Browsers don't let a script do everything a real user does, so the shim fills in:

- **focus** is pretended. real focus in the iframe would pull it off the page around it, so `focus()`, `select()` and `activeElement` are patched and focus events fire by hand
- **hover and focus styles** come from copies of the app's `:hover` and `:focus` rules, keyed to attributes the shim sets
- **typing** is done by hand, as a browser's default action: `beforeinput`, the change if nobody cancelled it, `input`. Not through the browser's editor: Firefox's scrolls the page around the frame to its caret. Fields are reset to their recorded value as they go
- **scroll** positions are recorded and set, pointer capture is patched for drags, and the app's `scrollIntoView` scrolls only inside the frame, never the page around it
- **select all** on Cmd/Ctrl+A is done by hand, like typing
- **randomness and time** are shared with the take: `Math.random` and `crypto` draw from one seeded generator, and `Date` reads what it read in the take while each event is handled. so ids the app mints in the browser come out the same as the ones the server frames name
- **hover** follows the page changing under a pointer that stands still, as in a browser

What the app sends goes nowhere. Links and form submits never navigate the replay. `input={false}` on `<LiveScene>` plays server frames only.

The recorder logs every key, so record in a session with nothing secret in it. While recording, the page's `Math.random` and `crypto` come from the seeded generator, so don't record anything that needs real randomness.

## Develop

```bash
pnpm install
pnpm build && pnpm test && pnpm check
```
