/**
 * Tape — a recorded take replayed in the real app, on a clock the page owns,
 * as headless parts:
 *
 *   <Tape.Root scene app label chapters>   the take and its clock, no DOM
 *     <Tape.Frame>                         the replay, scaled to fit
 *       <Tape.Scrubber />                  press and drag through it, keys too
 *     </Tape.Frame>
 *     <Tape.Chapters />                    the chapters as a timeline
 *     <Tape.Caption />                     the chapter playing, as a line
 *   </Tape.Root>
 *
 * Parts sit anywhere under Root, in any layout. Build your own on useTape
 * (state, by selector) and useTapeApi (seek, play, pause, chapter).
 *
 * Import the styles once, `@nustackdev/tape-player/tape.css`. Themed by CSS
 * variables, set on any ancestor (the root, for the scrubber: it floats over
 * the page from the body):
 *   --tape-accent         pointer, clicks, scrubber fill
 *   --tape-accent-text    timeline fill, caption number (defaults to accent)
 *   --tape-ink            caption title
 *   --tape-ink-soft       caption note
 *   --tape-ink-faint      caption count
 *   --tape-track          timeline track
 *   --tape-bg             the frame before the take shows
 *   --tape-shimmer        the loading sweep
 *   --tape-ring, --tape-ring-width, --tape-ring-offset   focus
 *   --tape-font-mono, --tape-fs-title, --tape-fs-num
 */
export type { Scene } from "@nustackdev/tape-scene";
export { LiveScene, type LiveSceneProps } from "./LiveScene";

import { Caption } from "./Caption";
import { Chapters } from "./Chapters";
import { Frame } from "./Frame";
import { Root } from "./Root";
import { Scrubber } from "./Scrubber";

export const Tape = { Root, Frame, Scrubber, Caption, Chapters };
export type { CaptionProps } from "./Caption";
export type { ChaptersProps } from "./Chapters";
export { type Chapter, chapterAt, progressAt } from "./chapter";
export type { FrameProps } from "./Frame";
export { type RootProps, type TapeApi, type TapeState, useTape, useTapeApi } from "./Root";
export type { ScrubberProps } from "./Scrubber";
