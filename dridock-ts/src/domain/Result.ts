/**
 * A typed either-value-or-error. Used at the "small function" boundary
 * inside services where callers care about the failure mode without
 * having to catch. Errors that are always programmer-bug (invariant
 * violations, bad input types) still `throw`; Result is for
 * expected-failure-modes callers act on.
 *
 * We deliberately don't use `Promise.reject` for these because the
 * migrator + safe-rewrite layer needs to enumerate outcomes at compile
 * time — the audit rule (visible warning + non-zero rc on any skip)
 * relies on being able to tag every non-success branch structurally.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}
export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** True if `r` is Ok. Narrows the type. */
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}
/** True if `r` is Err. Narrows the type. */
export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}
