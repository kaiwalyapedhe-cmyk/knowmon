# AGENTS.md

Project rules for anything an agent (or a human) changes in this repository.

## Project

- Cadence CX: React SPA in `frontend/`, FastAPI service in `backend/` (MongoDB, reference
  implementation), Rust service in `backend-rs/` (Axum + SQLx + PostgreSQL).
- `backend-rs/` is the maintained backend; `backend/` stays runnable and is not to be deleted.

## Mandatory coding standard: NASA Power of 10

**All code must be in full compliance with NASA's Power of 10 rules for safety-critical code**
(Gerard Holzmann, "The Power of 10: Rules for Developing Safety-Critical Code", 2006).

The rules below are normative. A change that cannot satisfy one of them must not be merged; if
the rule genuinely does not apply to a construct, state why next to the code instead of
silently ignoring it.

### 1. Restricted control flow

No recursion, direct or indirect (including mutually recursive helpers, recursive closures, or
recursive data traversal that a loop can express). No `goto`-style escapes: no `setjmp`/`longjmp`
equivalents, no `loop { … break 'label }` constructs used to emulate `goto`.
Prefer iterations, queues and explicit worklists over self-calls.

### 2. Fixed loop bounds

Every loop must have a bound that is statically obvious or provably terminates:

- iterate over a finite collection, or use a range with a constant/limited upper bound;
- `while` loops are allowed only when a bound or termination argument is visible in the same
  function (e.g. a `remaining` counter that strictly decreases and a `max_attempts` cap);
- no unbounded retries, spin waits or cursor loops: cap attempts/iterations with a named
  constant and fail with a typed error when the cap is reached;
- no `loop { … }` without an explicit counter or a documented, checked termination condition.

### 3. No dynamic allocation after initialization

All allocation must be bounded and capped, never open-ended:

- every request body, upload, list response, page size, batch and buffer has a hard maximum
  (validated before allocation, not after);
- reserve with `Vec::with_capacity` / `String::with_capacity` where the size is known;
- no unbounded accumulation of user-controlled data in memory (stream, page or reject);
- long-lived shared state is initialized once at startup; no hidden lazy growth per request.

### 4. Small functions

A function must not exceed 60 lines of code (signature and braces excluded). Split it instead of
adding `#[allow(clippy::too_many_lines)]`. This is a hard limit, not a target.

### 5. Assertion density

Every function carries at least two assertions on average, placed to document the invariant it
relies on:

- check parameters and state transitions with `assert!` / `debug_assert!`;
- assertions must be free of side effects and must not be used as input validation or error
  handling — user input is rejected with typed errors (see rule 7);
- never disable assertions to make a test pass.

### 6. Smallest possible scope

Declare every value at the innermost scope that uses it. No file-level mutable state; shared
initialization goes through `OnceLock`/`Arc` set during startup. Constants live next to the code
that owns them, not in a global grab-bag module.

### 7. Check returns and validate parameters

- Every `Result` is handled: `?`, an explicit match, or a logged-and-returned typed error.
  `let _ = …`, `unwrap()` and `expect()` are forbidden outside tests and module-level
  initialization.
- Every function validates its parameters on entry (shape, range, ownership/role) and returns
  the typed error type (`AppError`) rather than panicking.
- No panics reachable from request handling; indexing, slicing and arithmetic on user input are
  checked.

### 8. Limited preprocessor / macro use

`#include` and simple `#define`-level constructs only. In Rust: no `macro_rules!` or procedural
macros for control flow or business logic — use constants, functions and generics. Derive macros
and the standard attribute macros are fine. Keep Cargo features to what is actually required.

### 9. Restricted pointers

No `unsafe`, no raw pointers, no manual memory management in application code. If an FFI boundary
makes `unsafe` unavoidable, it is isolated in one small module, carries a `// SAFETY:` comment
proving each invariant, and asserts its preconditions at the boundary. Prefer references,
ownership and checked accessors everywhere else.

### 10. Zero warnings, maximum strictness

Code is compiled from the first day with the most pedantic settings available, and warnings are
errors:

```bash
# backend-rs
RUSTFLAGS="-D warnings" cargo build
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Never silence a warning with `#[allow(...)]` to get a build through; fix the cause. Any new lint
that fires must be fixed in the change that introduces it.

## Applying the rule

- Full compliance is required for all new code and for every function a change touches
  (a touched function that violates a rule is fixed in the same change).
- Code written before this rule is migrated as it is modified; do not add new violations.
- Reviewers reject changes that violate rules 1, 2, 5, 7 or 10 outright — those are the ones
  that hide defects rather than merely costing style points.

## Verification

- Rust: `cargo build`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, plus the
  API smoke suite in `backend-rs/tests/smoke.py` against a real PostgreSQL instance.
- Frontend: `npm run build` in `frontend/`.
- Python reference service: leave it runnable; when it is changed, apply the same rules to the
  touched code where the language allows (no recursion, bounded loops, checked exceptions,
  validated parameters, no bare `except:`).
