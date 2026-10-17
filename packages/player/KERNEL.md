# The replay kernel

How a take plays, and why it can't drift, desync or leak out of its frame.

## Invariants

1. **One timeline.** A scene is one ordered log. Server frames, the app's own
   sends, socket opens and closes, pointer moves, buttons, keys, scrolls, field
   values, focus, selection and navigation sit in it in the order the recorded
   browser handled them, on the recorded browser's clock. There is no second
   track, no fallback path and no second clock.
2. **One executor.** Inside the iframe a single loop applies the log strictly in
   order. Nothing else delivers anything to the app.
3. **A closed loop.** What the app sent is in the log. The executor doesn't send
   it, it waits until the replayed app has: whatever the server said after it
   is a reply, and reaches the app only once the app asked. So data can't run
   ahead of the interaction that requested it, however fast a take catches up.
4. **Preconditions before input.** Every input entry carries what the recorded
   page looked like when it was handled: the target element for pointer buttons,
   the focused element for keys, the field for values. The executor waits,
   bounded, until that holds, then acts on the verified target. Default actions
   (caret, typing, select all) act only on it. Nothing ever selects the body or
   the document.
5. **The host shows processed time.** The executor reports how far it has
   applied the log, and only after the page settled. The host draws the cursor,
   captions, chapters and scrub position from that report, never from its own
   clock. The host clock only says how far the executor may go, at most
   `LEAD_MS` ahead of what was applied. Under load the replay slows down; it
   can't run ahead of the app. The cursor sits on the last applied sample, never
   on the way to the next.
6. **Promotion is earned.** A new take is shown only after it reports that it
   applied the log up to the host's clock and the page settled. No timer ever
   shows a take.
7. **Failure restarts.** A precondition that never holds, a send that doesn't
   match, an executor that goes silent, a frame that unloads or navigates: the
   take is dropped and a fresh one starts from the last shown position.
8. **Isolation.** The take can't reach the page around it, can't touch the
   tab's history through its own history API, can't navigate the page, open
   windows or dialogs, can't take the visitor's focus or scroll their page, and
   gets no real input.

## Event log

`Scene` version 2 (`@nustackdev/tape-scene`):

```
{ tape: 2, meta, storage: { local }, sockets: [{ url }], log: Entry[] }
```

Every entry has `t` (ms since the recorded page's navigation start, browser
`performance.now()`), and may have `r` (random draws before it) and `w` (the
pinned `Date.now()` while it was handled). Kinds:

| k | fields | applied as |
| --- | --- | --- |
| `open` | `s` | socket `s` (creation order) opens |
| `msg` | `s`, `d`, `x?` | one server message, its own task; a run of them, queued at once |
| `close` | `s`, `c` | the server closed socket `s` with code `c` |
| `send` | `s`, `h`, `d?` | the app sent a message on `s` hashing to `h` (`d` is it, for reports): waited for, never sent |
| `move`, `out` | `x`, `y` | pointer moves, hover follows; `out` leaves the page |
| `down`, `up`, `click`, `dblclick`, `contextmenu` | `x`, `y`, `b`, `m`, `h`, `bx?` | dispatched to the element `h` names |
| `keydown`, `keypress`, `keyup` | `key`, `code`, `m`, `rep?`, `f` | dispatched to the focused element, which must be `f` |
| `scroll` | `p`, `x`, `y` | element `p` scrolls |
| `value` | `h`, `v` | the focused field, if it is `h`, holds `v` |
| `focus` | `h` (null: none) | virtual focus moves to target `h` |
| `sel` | `h`, `a`, `b` | the focused field's selection, if it is `h` |
| `range` | `a`, `b` (node path, offset) | selection in the focused editable |
| `nav` | `path`, `mode`, `by?` | app navigation: an assertion. `by: "user"`: a browser back/forward, performed |

The recorder takes every entry from inside the recorded page: it wraps the
page's `WebSocket`, sees each message as the app does and each send as the app
makes it, so the order of frames, sends and input is the browser's order, not
the proxy's.

A target is `{ p, n, h?, a? }`: child-index path from `<html>`, tag name, an
FNV-1a hash of the element's whitespace-collapsed text when that is 80
characters or less, and for form fields a hash of what names them (type, name,
id, placeholder, label) instead. A pointer target must match path and identity;
`focus`, `value` and `sel` match identity only.

`focus`, `value`, `sel` and `range` record what a browser default action did,
in the middle of doing it. The replay performs those default actions itself,
so by the time one of these entries comes up the app may already have moved
things. So they act on what the replay focused, only when it is the one
recorded, correct only what differs, and are soft: skipped, not failed, if they
can't apply. A field write never goes to a field other than the recorded one.

## Executor loop

```
for each entry e, in order:
  while e.t > until: settle (unless `until` passes e first), then position = until,
    report idle; wait for a new `until`
  if e is input and anything was applied since the last settle: settle
  if e starts a run of messages due by `until`: apply the run, each in its own task,
    all queued at once, up to `burst` ms; position = the last applied; next
  if e diverged (a send that doesn't match): fail
  if e is waived: skip it unless its precondition holds now
  else wait until precondition(e) holds      (bounded, playing time only)
    timed out: soft entries are skipped, hard ones fail the take
  pin Date to e.w, seek randomness to e.r
  apply(e)
  next task, then unpin (finally)
  position = e.t
```

- **settle**: one task, then animation frames (raced with a short timeout) until
  two frames in a row pass with no DOM mutation, so a framework that commits a
  frame late (React's deferred and concurrent renders) has had its turn. Bounded
  in wall time by `SETTLE_MAX_MS`: an animation that never stops can't hold the
  take, it just costs the bound.
- **runs of messages**: server messages with nothing else between them are a
  backlog, and get what a browser gives a backlog of socket frames: each its
  own task, all queued before anything the app queues meanwhile. So the app
  renders once for many, not once per message. A run stops after `burst`
  (50ms) of delivery, and the page renders before the next. Measured on the
  training scene (about 200 messages a second for 6s), Chromium at CPU x4:
  scene 5s to 11s took 42s with a task and a render per message, 16s now.
  Nothing settles inside a run; the page settles before the input that
  follows it. The clock stays pinned per message, into the next one's task.
- **settling at the clock** gates only what is reported. If `until` moves past
  the next entry while the page settles, the executor goes on at once,
  unsettled: a page rendering a stream would otherwise pay a settle (up to
  `SETTLE_MAX_MS`) every `LEAD_MS` of it.
- **playing time**: deadlines count only while the host says the take plays
  (`run`), and the page is visible. Paused, off screen, a hidden tab: nothing
  counts, so nothing fails for it.
- **position** only moves forward, only as entries are applied or as `until`
  passes with nothing due, and never ahead of a settle. Pausing stops `until`;
  resuming continues from the same entry. No drift, by construction.
- **sends** wait for the replayed app to have sent the same message (by hash)
  on the same socket, so whatever the server said after it reaches the app
  only once the app asked. They match by content, not position: one input can
  make an app send from two async paths, in either order depending on load,
  and both orders are the same session. A recorded send the app never makes
  holds the take until its deadline, then fails it, with the message in the
  reason. A send the take never made is counted, not failed: no reply in the
  log waits on it, so it can't make data run ahead, and apps make such sends
  for reasons the log can't order (measured: nuspace's NavRef echoes a
  popstate with a `notify`, but only if its effect had subscribed by then,
  which in the take it hadn't, 2.4ms after the push). With `input={false}`
  nothing replays what made the app send, so sends aren't waited on there.
- **gestures** (a press, the moves while held, the release and its click)
  replay relative to the element that held the whole gesture in the take: the
  smallest of the pressed element and its ancestors (boxes recorded on `down`)
  that contains every point. Each point maps through that element's box then
  onto its box now. A browser with other text metrics lays a slider's track
  out a few pixels off; mapped, the pointer is at the same fraction along it,
  and the slider ends on its recorded value. (Seen: a Chromium take of the
  nuspace slider, replayed in Firefox at raw pixels, never sent the value the
  take sent.) Boxes are recorded exact. Takes recorded before that have them
  to 0.1px or 0.001px. Mapped through as stored, a box moves the point by its
  rounding, and pointer coordinates are float32 and often sit right below a
  rounding boundary of what the app computes, so even 0.00025px counts (seen:
  the training pad, top 408.28125 stored as 408.281, normalized by the app to
  four decimals, sent 0.1738 for 0.1737, in all three engines). So a 0.001px
  value is put back on the layout grid it was measured on, 1/64px (Chromium,
  WebKit) or 1/60px (Firefox), the one point of either within the rounding,
  and maps exactly from there. A box that rounds to what the element measures
  now is the same box: the point stays as recorded. A 0.1px box can't be put
  back (several grid points are within its rounding); a 0.1px take of a layout
  that differs by less than the rounding (Firefox lays the pad 0.002px lower)
  can't be mapped exactly; record it again.
- **the app's own back and forward** are held: `history.back()` queues, and
  the replay performs it, firing popstate, where the log has its `nav pop`
  entry. So the app sees the traversal in the order the take had it, not a
  task after it asked.
- **deadlines measure lack of progress.** A look in which the page did work
  (its DOM changed) doesn't count against the entry's deadline: that page is
  slow, not stuck. Busy looks count too once the wait reaches `busy` (4) times
  the deadline, so an app that never goes still (an animation) can't hold a
  take that went wrong forever.
- **deadlines** count at most `tick` (100ms) per look. A page the machine
  starves, looking once a second instead of every 30ms, gets as many looks
  before it fails as one that runs freely.
- Faults inside `apply` (our code throwing) fail the take. What the app's
  handlers throw, socket handlers included, is reported (`reportError`) as a
  browser would, and never reaches the executor.

The app's own timers (`setTimeout`, `setInterval`, debounces) run on wall time,
not log time. That is what makes the closed loop matter: a debounced request is
sent when the app's timer fires, and the reply waits for it. Moving timers onto
log time would make catch-up instant for such apps, at the cost of running app
code on a clock it never had; not done.

## Watchdog

In the executor: every precondition wait has a deadline (`open` gets a longer
one, it waits on the bundle loading). On expiry it posts `fail` with the entry
index and the reason. While waiting it posts a heartbeat.

In the host, per take:
- loaded without a `hello`, or not loaded after `BOOT_HARD_MS`: failed.
- playing, busy (behind its `until` or not settled) and silent for `SILENT_MS`
  of playing time: failed. A slow take reports as it applies (at most every
  32ms of playing time), so slowness never trips this; only silence does.
- `gone` (its page unloads, not into the back/forward cache with the tab) or a
  second `load` of its iframe: failed. `gone` says why: `beforeunload` (a
  navigation it started), `hashchange` or `popstate` (a real one), or
  `teardown`: a `pagehide` with no `beforeunload` before it, which in all
  three engines means the frame was taken out of the document, not navigated
  (measured). Takes the host itself removed send `teardown`; the host logs
  those at debug level (`tape: take sN gone (teardown)`) and everything else in
  the failure warning, so recycling and the navigation safety net read apart.

A failed take is removed at once. A fresh take starts at the shown position,
after a backoff; the old front, if alive, stays on screen frozen until the new
one is promoted. Two failures at one entry waive its precondition: it is no
longer waited on, and it is skipped, never applied, when it doesn't hold. The
first take that passes the entry clears its failures and its waiver. A take
after failures in a row gets more patience (`PATIENCE`, doubling per failure,
up to 8x): its precondition deadlines and its silence window grow, so a
restart is never the same attempt as the one that timed out. Six
failures without a promotion in between stop the tape, with the reasons on the
console; coming back near the viewport tries again.

## Isolation

- **Origin, by what the browser can enforce.** `Tape.Root isolation`, "auto"
  by default:
  - Where the browser has the Navigation API (current Chromium, Firefox and
    WebKit), the iframe's sandbox is `allow-scripts allow-forms
    allow-same-origin`. The frame then has the Navigation API too, and the
    shim cancels every navigation it starts at its `navigate` event: links,
    forms, `location.href`, `assign`, `replace`, `reload`, and fragment changes.
    Measured: in a sandboxed frame without `allow-same-origin`, a fragment
    change adds an entry to the tab's history that nothing catches, and in
    Chromium and WebKit removing the frame afterwards doesn't take it back out.
    The cost: the app's own script could reach the page around it by naming
    `window.parent` or `top`. The shim never does, and the host never reads the
    take either.
  - Elsewhere, an opaque origin (`allow-scripts allow-forms`): the page around
    the take, its DOM, history, storage and cookies are out of reach by
    construction. The bundle is then fetched cross origin and needs
    `Access-Control-Allow-Origin: *` (GitHub Pages sends it). The take gets
    `localStorage`, `sessionStorage` and `document.cookie` in memory. WebKit
    won't let an opaque frame move its url to the recorded path; the shim says
    so (`origin`) and takes on that page run same origin.
  - "opaque" and "same-origin" force either.
- **A frame that leaves is removed before it lands.** A navigation that gets
  past the guards asks to unload first: the shim posts `gone` from
  `beforeunload`, and the host takes the iframe out of the document right then,
  synchronously (the Frame makes each iframe itself, in a box React renders,
  so it can). The navigation never commits: nothing loads, the tab's history
  doesn't grow (measured in all three engines). A frame that loads a second
  page anyway, or fires a real `hashchange` or `popstate`, is removed as well.
  Each time the host puts its scroll and focus back, and a fresh take starts.
- **Virtual history.** `pushState`, `replaceState`, `back`, `forward`, `go`,
  `length` and `state` run on an in-memory stack. The URL the app reads is set
  with the real `replaceState`, which never adds an entry to the tab's history,
  and only when it changes. Traversals and fragment changes fire `popstate` and
  `hashchange` by hand, in one task queue, a task later, like a browser.
  `navigation.back()`/`forward()` route there too.
- **Navigation guard.** With the Navigation API (same origin), every navigation
  the frame starts is cancelled at its `navigate` event. Always: link clicks and
  form submits are cancelled by a listener that runs first and turns any
  `stopPropagation` into `preventDefault`, and by one that runs last; a link
  clicked outside the document is cancelled on itself; `form.submit()` does
  nothing; validation never shows the browser's bubble. A frame that navigates
  anyway (`location.assign`, `reload`) unloads, and the host replaces it; it
  can't navigate the page around it (no `allow-top-navigation`).
- **`window.open`** returns null; `alert`, `confirm`, `prompt`, `print` do
  nothing.
- **Focus.** The replay's focus is pretended. What would focus for real is
  stopped at the source: `autofocus` (set by script, as an attribute, or in
  parsed html), a label's activation, a modal dialog opening. The iframe is
  `inert`, out of the keyboard's reach. Should real focus still land in the
  frame, the shim tells the host, which hands focus back to where it was and
  puts its scroll back.
- **Scroll.** `scrollIntoView` scrolls only inside the frame. Before an edit left
  to the browser's editor (some scroll the page to the caret), the shim tells
  the host, which holds its scroll for a moment, with listeners that go with
  the hold.
- **No real input.** Trusted pointer, mouse, key, wheel, touch and focus events
  in the frame are stopped before the app sees them, and the frame has
  `pointer-events: none` under an overlay.
- **No selection.** Inside the frame everything is `user-select: none` but what
  the replay is editing, and a selection outside it (a stray select all, find in
  page) is dropped as it is made. Frame, overlay and captions are
  `user-select: none` on the page too.
- **Inert without a take.** The shim boots only with a take id in the url
  hash, given by a live host. A reloaded frame has none: the app's module
  scripts stay inert, nothing posts. Every take's iframe is named `tape-take`,
  a name its page can read whatever its origin, and a `Tape.Root` under that
  name (the site loaded into its own replay) renders nothing.

Gaps that remain, where the browser gives no hook:
- Opaque (browsers without the Navigation API, or forced): a fragment change
  by the app's script adds one entry to the tab's history. The take is
  replaced; in Chromium and WebKit the entry stays.
- Same origin: the app's script could reach `window.parent` or `top` by name.
- Frames the app makes inside the take don't get the shim: their own history
  calls reach the tab's.

## Offscreen

A frame out of view pauses (the host stops `until` and tells the take it
doesn't play). A frame far from the viewport for `PARK_MS` drops its takes, and
starts a fresh one at the same time when it comes near again, so a long page
with many tapes holds only the ones near the viewport in memory.

## Open issues

- Tab between table cells may not replay. The replay doesn't perform Tab's
  focus navigation; it relies on the recorded `focus` entry, which is soft. If
  the app creates the cell editor on focus, `focus` can resolve to nothing, get
  skipped, and the next key waits on a focus that never moves (`input.ts`
  keydown, `shim.ts` `focusTo`). Drivers use double click to enter cells.
- A mid-line edit in CodeMirror can land one glyph off. `caretAt` picks the
  nearest glyph boundary on mousedown, and the recorded `range` that corrects
  it is soft and addresses text nodes by child-index path, which CodeMirror
  rebuilds, so the correction can be skipped (`input.ts` `caretAt` and
  `range`). Drivers clear and retype code.
- Headless WebKit on Linux crashes pages ("Page crashed") at three or more
  concurrent pages, with or without harness actions; two run clean. Not seen in
  a single page or desktop Safari. Unconfirmed whether it's the engine build or
  the kernel.
