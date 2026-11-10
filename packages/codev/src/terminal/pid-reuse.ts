/**
 * The PID-reuse tolerance, shared by the session manager, the husk sweep and the
 * shellper transport (Spec 1658, Amendment 2). Leaf module (no imports).
 */

/**
 * PID-reuse guard tolerance: a live process's start time must match the one
 * recorded for its shellper within this window, or the pid belongs to a
 * different process.
 */
export const PID_REUSE_TOLERANCE_MS = 2000;
