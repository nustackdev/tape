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

## What replays

- every server frame, on its recorded time, per socket. sockets are matched by url in open order, so a reconnect in the take replays as one
- client side navigation (history push, replace, pop)
- localStorage at load, as a private copy
- the pointer, as a drawn cursor with click ripples

What the app sends goes nowhere. Local only UI state (hover, scroll, a menu the server never heard about) does not replay.

## Develop

```bash
pnpm install
pnpm build && pnpm test && pnpm check
```
