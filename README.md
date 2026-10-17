# tape

Record a websocket UI session, replay it anywhere.

Tape puts a proxy in front of a running app and a script in its page that logs, in the page's own order, what the server sends over its sockets and what the pointer and keys do, all into one `scene.json`. The player then runs the real app bundle in an iframe with `window.WebSocket` swapped for a fake that replays the scene, a cursor drawn on top. No screenshots, no video: the app on the page is the real one.

Works for any UI driven by a websocket. Frames are opaque bytes, tape never reads them.

## Packages

| package | what |
| --- | --- |
| `@nustackdev/tape` | the `tape` CLI: record, bundle, trim, info |
| `@nustackdev/tape-player` | `<LiveScene>` and the `Tape` parts (react), and the shim that runs inside the iframe |
| `@nustackdev/tape-scene` | the scene format and its helpers |
| `@nustackdev/tape-render` | the `tape-render` CLI: a scene to mp4 and gif, for READMEs and posts |

## Install

```bash
npm i -D @nustackdev/tape          # the CLI
npm i @nustackdev/tape-player      # <LiveScene>, Tape
npm i -D @nustackdev/tape-render   # mp4 and gif, needs ffmpeg
```

## Record

```bash
tape record http://127.0.0.1:8080 -o hero.json
```

Open the printed url, click around, ctrl+c to save. A reload starts a new take. Record in a browser profile without extensions: one that adds elements to the page shifts the element paths the replay checks against. Then cut it:

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

The replay runs in a sandboxed frame of its own, an opaque origin, so the bundle is fetched cross origin: serve it with `Access-Control-Allow-Origin: *`. GitHub Pages does; a dev server needs the header (vite: `server.headers`). A host that can't send it passes `sameOrigin` to `Tape.Root`.

## Play

```tsx
import { LiveScene } from "@nustackdev/tape-player";
import "@nustackdev/tape-player/tape.css";

<LiveScene app="/scenes/app/index.html" scene="/scenes/hero.json" aspect={16 / 10} />
```

The frame has a fixed aspect, empty until the replay is on screen, so nothing shifts. It loads after first paint and only near the viewport, plays in view, pauses off screen, loops. With `prefers-reduced-motion` it shows the last frame, still. The app renders at the recorded viewport size and is scaled to fit.

The cursor and the click ripple are yours to draw: `cursor` takes a node, drawn with its top left on the pointer tip, its box marked `data-down="1"` while pressed; `click` takes a node drawn centred on each click for `clickMs`, animated with your CSS. `cursor={false}` and `click={null}` turn them off.

```tsx
<LiveScene app={app} scene={scene} cursor={<MyCursor />} click={<MyClick />} clickMs={480} />
```

## Play, with controls

`Tape` is the same replay as parts, on a clock the page owns: play, pause, seek both ways, chapters. `Tape.Root` holds the take and renders nothing; the parts sit anywhere under it, in any layout.

```tsx
import { Tape } from "@nustackdev/tape-player";
import "@nustackdev/tape-player/tape.css";

<Tape.Root app={app} scene="/scenes/movies.json" label="The movies demo" chapters={chapters}>
  <Tape.Frame aspect={16 / 10}>
    <Tape.Scrubber />
    <Tape.Caption />
    <Tape.Chapters />
  </Tape.Frame>
</Tape.Root>
```

| part | what |
| --- | --- |
| `Tape.Root` | the take and its clock. `storage` lays keys over the take's localStorage (a change restarts it in them), `ready={false}` holds the load, eg until the theme is known |
| `Tape.Frame` | the replay, scaled to fit, the recorded pointer and clicks over it. Loads near the viewport, plays only on screen. Its children are drawn over the replay |
| `Tape.Scrubber` | inside the Frame: the frame becomes one control. Press anywhere and drag sideways through the take, mouse or touch; keys too (arrows, shift+arrows by chapter, Home, End, Space) |
| `Tape.Caption` | the chapter playing, as a line: number, title, note. Pass a function as children to render it yourself |
| `Tape.Chapters` | the take as a timeline cut into its chapters, one fill along it. Click a chapter to play from it |

Chapters are config, not part of the recording, so one take can be told differently per page and edited without recording again:

```ts
const chapters = [
  { t: 0, title: "Add a film", note: "Type a name, press Add." },
  { t: 9000, title: "Mark it watched", note: "The count at the top follows." },
];
```

`t` is ms of the take; `tape info` prints a scene's length and trim window. A part of your own reads the tape with `useTape` (a selector: it re-renders only when what it picks changes) and drives it with `useTapeApi`:

```tsx
const chapter = useTape((s) => s.chapter);
const { seek, play, pause, chapter: jump } = useTapeApi();
```

The parts are unstyled but for what they need to work, and themed by CSS variables. Set them on the root: the scrubber floats over the page from the body.

| variable | for |
| --- | --- |
| `--tape-accent` | pointer, clicks, scrubber fill |
| `--tape-accent-text` | timeline fill, caption number |
| `--tape-ink`, `--tape-ink-soft`, `--tape-ink-faint` | caption title, note, count |
| `--tape-track` | timeline track |
| `--tape-bg`, `--tape-shimmer` | the frame before the take shows, its loading sweep |
| `--tape-ring`, `--tape-ring-width`, `--tape-ring-offset` | focus |
| `--tape-font-mono`, `--tape-fs-title`, `--tape-fs-num` | type |

## Render

Where a page can't run the replay, a README or a post, render it to video:

```bash
tape-render hero.json --app public/scenes/app -o hero            # hero.mp4 and hero.gif
tape-render hero.json --app public/scenes/app -o hero -f gif --gif-width 800 --theme light
```

Same replay as the player, in headless Chromium, screenshot frame by frame. Screenshots are slow at 2x, so the take runs in slow motion while it is captured, the clock and the page's CSS animations both, and every frame is stamped with the take time it shows. The encode holds each frame until the next one's time, so the output plays at the take's own pace whatever the machine managed. `--slow auto` picks the factor from a quick measure of the capture rate.

The pointer is yours to style, as in the player: `--cursor` and `--click` take html files, `--css` styles them.

- `.tape-cursor` sits with its top left on the pointer tip, inside a box marked `data-down="1"` while pressed
- each click is drawn centred on it for `--click-ms`, with `--tape-click-p` going 0 to 1 over that time for css that wants it, besides plain keyframes
- `--theme dark` sets the browser's color scheme and a `dark` class on the root, for css that differs by theme. `--storage nuspace.theme=dark` is how the app itself gets told

Also `--start`/`--end` to cut, `--speed`, `--lead`/`--hold` to hold the first and last frame, `--scale`, `--fps`, `--crf`, `--gif-fps`, `--gif-width`, `--gif-colors`, `--gif-dither`. `tape-render --help` for all of it. From code: `capture()`, then `encodeMp4()` / `encodeGif()`.

## What replays

One log, played in order by one loop inside the frame (see [the kernel](packages/player/KERNEL.md)):

- every server frame, in the order the page got it relative to the input, per socket. sockets are matched by creation order, so a reconnect in the take replays as one
- the input, as DOM events fed into the app: clicks, keys, drags, scrolls. so local UI plays too: menus open, fields fill, hover buttons show. each waits until its target is there, the same element the take recorded, and keys until focus is where it was
- what the app sends, as a check: the server's reply reaches the app only after the replayed app sent what it sent in the take
- the app's navigation, on a history of its own: the take never touches the tab's history, and nothing in it can navigate the page or itself
- localStorage at load, as a private copy
- the pointer, as a drawn cursor with click ripples, drawn at what the app has been fed so far: a slow device slows the replay, it never falls out of step

A take that can't go on (a target that never shows) is replaced by a fresh one from the same point.

Browsers don't let a script do everything a real user does, so the shim fills in:

- **focus** is pretended. real focus in the iframe would pull it off the page around it, so `focus()`, `select()` and `activeElement` are patched and focus events fire by hand
- **hover and focus styles** come from copies of the app's `:hover` and `:focus` rules, keyed to attributes the shim sets
- **typing** is done by hand, as a browser's default action: `beforeinput`, the change if nobody cancelled it, `input`. Not through the browser's editor: Firefox's scrolls the page around the frame to its caret. Fields are reset to their recorded value as they go
- **scroll** positions are recorded and set, pointer capture is patched for drags, and the app's `scrollIntoView` scrolls only inside the frame, never the page around it
- **select all** on Cmd/Ctrl+A is done by hand, like typing, on the focused field or editable only, never the page
- **randomness and time** are shared with the take: `Math.random` and `crypto` draw from one seeded generator, and `Date` reads what it read in the take while each event is handled. so ids the app mints in the browser come out the same as the ones the server frames name
- **hover** follows the page changing under a pointer that stands still, as in a browser

What the app sends goes nowhere. Links, form submits, `location` and reloads never navigate the replay, windows and dialogs never open, and the visitor's own pointer and keys never reach it. `input={false}` on `<LiveScene>` (or `Tape.Root`) plays server frames only.

The recorder logs every key, so record in a session with nothing secret in it. While recording, the page's `Math.random` and `crypto` come from the seeded generator, so don't record anything that needs real randomness.

## Develop

```bash
pnpm install
pnpm build && pnpm test && pnpm check
```
