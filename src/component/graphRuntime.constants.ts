/**
 * GraphRuntime constants: dirty-flush anti-loop limits.
 *
 * @module Effectable/component/graphRuntime.constants
 */

/**
 * Maximum consecutive `flushDirtyFibers` passes in one microtask chain
 * (each pass that leaves dirty work schedules the next).
 * On overflow the queue is cleared and the error is forwarded to `onAutoReconcileError`.
 */
export const GRAPH_RUNTIME_MAX_DIRTY_FLUSH_PASSES = 50 as const;

export type GraphRuntimeMaxDirtyFlushPasses = typeof GRAPH_RUNTIME_MAX_DIRTY_FLUSH_PASSES;
