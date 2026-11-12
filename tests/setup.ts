import { setLogSettleMs } from '../hooks/disk-log.ts';

// 0.5.24: the disk log waits a few ms before its read-back in production. Tests drive detached work
// with setImmediate and would see that wait as lateness, so the suite runs with no wait.
// tests/forced-handoff.test.ts (concurrent writers) sets it back for its own cases.
setLogSettleMs(0);
