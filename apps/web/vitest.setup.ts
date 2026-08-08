/**
 * Extends vitest's `expect` with the DOM matchers (`toBeInTheDocument`,
 * `toHaveAccessibleName`, and the rest). The `/vitest` entrypoint registers
 * against vitest's own Assertion interface rather than Jest's.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmounts between tests. NOT redundant.
 *
 * React Testing Library registers this itself — but only by reaching for a
 * global `afterEach`, and `globals: false` in vitest.config.mts means there
 * isn't one. Without this, every render stays in the document and the failures
 * are baffling rather than obvious: a query matches "multiple elements" that the
 * test never rendered, and `user.tab()` lands on a control left behind by the
 * test before it.
 *
 * It went unnoticed until the first component spec because nothing before it
 * rendered anything.
 */
afterEach(cleanup);
