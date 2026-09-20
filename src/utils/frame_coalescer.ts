/**
 * Runs one piece of scroll-driven work per animation frame.
 *
 * A `scroll` listener fires many times between two paints, and each firing would
 * measure the same layout. Requesting a frame on the first firing and ignoring
 * the rest until it runs keeps the reads to one per frame; running on the frame
 * — rather than on a timer — keeps the measurement in step with what the reader
 * sees.
 *
 * **The first request of a burst wins.** Work handed in while a frame is already
 * pending is dropped, so a caller that queues a special first pass and then
 * receives scrolls gets that first pass, not the last scroll's.
 *
 * Cancelling drops the pending frame outright, and does nothing at all when none
 * is pending. A frame really is cancelled, so nothing needs a generation to tell
 * a stale callback from a fresh one, and nothing has to be refused before the
 * caller starts listening.
 *
 * Scope is the scheduling only. What to measure stays with the caller.
 *
 * @example
 * ```ts
 * readonly #frames = new FrameCoalescer();
 *
 * readonly #onScroll = (): void => this.#frames.schedule(() => this.#measure());
 *
 * disconnect(): void {
 *   this.#frames.cancel();
 * }
 * ```
 */
export class FrameCoalescer {
  #frame: number | null = null;

  /**
   * Runs `run` on the next frame, unless a frame is already pending — the first
   * request of a burst wins and the rest are dropped. The pending frame is
   * released before `run`, so `run` may request the next one.
   */
  schedule(run: () => void): void {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      run();
    });
  }

  /**
   * Drops the pending frame, and reaches the platform only when there is one.
   *
   * There is no handle value that stands for "nothing pending":
   * `cancelAnimationFrame` takes an `unsigned long`, so a negative placeholder
   * arrives as a large positive number that the same allocator can hand out, and
   * an idle cancel would then drop a frame belonging to someone else.
   */
  cancel(): void {
    if (this.#frame === null) return;
    cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }
}
