/**
 * Largest delay a timer can hold: the platform stores it in a 32-bit signed
 * integer, and anything larger wraps around, so a delay meant to be far in the
 * future can fire almost immediately. A declared delay above this bound names
 * no delay at all, and a controller reading one falls back to its default.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
