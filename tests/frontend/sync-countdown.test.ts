/**
 * Sync countdown logic tests.
 *
 * The countdown in App.tsx works like this:
 *   - scheduleCountdown() is called on every canvas onChange
 *   - It records lastChangeTime = Date.now()
 *   - 400ms after the LAST change (idle guard), a setInterval starts
 *   - Interval ticks every 200ms, shows Math.ceil((lastChange + DEBOUNCE_MS - now) / 1000)
 *   - Countdown clears when remaining <= 0 or when sync starts
 *
 * These tests simulate that logic with fake timers so we can verify the
 * exact behaviour without mounting React.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const DEBOUNCE_MS = 3000;
const IDLE_GUARD_MS = 400;
const TICK_MS = 200;

// ── Pure simulation of the countdown mechanism ────────────────

interface CountdownSim {
  scheduleCountdown: () => void;
  cancelCountdown: () => void;     // called when sync starts
  getCountdown: () => number | null;
  cleanup: () => void;
}

function makeCountdownSim(): CountdownSim {
  let lastChangeTime = 0;
  let countdown: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  function startTicking() {
    if (tickInterval) clearInterval(tickInterval);
    const initial = Math.ceil((lastChangeTime + DEBOUNCE_MS - Date.now()) / 1000);
    countdown = initial > 0 ? initial : null;
    tickInterval = setInterval(() => {
      const remaining = Math.ceil((lastChangeTime + DEBOUNCE_MS - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(tickInterval!);
        tickInterval = null;
        countdown = null;
      } else {
        countdown = remaining;
      }
    }, TICK_MS);
  }

  function scheduleCountdown() {
    lastChangeTime = Date.now();
    // Reset idle guard — any new change pushes the idle window
    if (idleTimer) clearTimeout(idleTimer);
    // Hide countdown while actively drawing
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    countdown = null;
    // Show countdown only after IDLE_GUARD_MS of quiet
    idleTimer = setTimeout(startTicking, IDLE_GUARD_MS);
  }

  function cancelCountdown() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
    countdown = null;
  }

  function cleanup() {
    cancelCountdown();
  }

  return {
    scheduleCountdown,
    cancelCountdown,
    getCountdown: () => countdown,
    cleanup,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('sync countdown — idle guard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows null while actively drawing (within idle guard window)', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();
    // Still within the 400ms idle guard
    vi.advanceTimersByTime(IDLE_GUARD_MS - 10);
    expect(sim.getCountdown()).toBeNull();
    sim.cleanup();
  });

  it('starts showing countdown after idle guard passes', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();
    vi.advanceTimersByTime(IDLE_GUARD_MS + TICK_MS);
    expect(sim.getCountdown()).toBeGreaterThan(0);
    sim.cleanup();
  });

  it('resets idle guard on each new change — no countdown while drawing', () => {
    const sim = makeCountdownSim();

    // Rapid changes every 100ms for 600ms total
    for (let i = 0; i < 6; i++) {
      sim.scheduleCountdown();
      vi.advanceTimersByTime(100);
    }
    // 600ms elapsed but idle guard resets each time — countdown still null
    expect(sim.getCountdown()).toBeNull();

    // Now stop drawing; after idle guard the countdown appears
    vi.advanceTimersByTime(IDLE_GUARD_MS + TICK_MS);
    expect(sim.getCountdown()).toBeGreaterThan(0);
    sim.cleanup();
  });
});

describe('sync countdown — tick behaviour', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts at DEBOUNCE_MS/1000 seconds after idle', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();
    vi.advanceTimersByTime(IDLE_GUARD_MS + TICK_MS);
    expect(sim.getCountdown()).toBe(DEBOUNCE_MS / 1000);
    sim.cleanup();
  });

  it('counts down and reaches null when debounce fires', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();

    // Let idle guard pass + full debounce elapse
    vi.advanceTimersByTime(IDLE_GUARD_MS + DEBOUNCE_MS + TICK_MS * 2);
    expect(sim.getCountdown()).toBeNull();
    sim.cleanup();
  });

  it('passes through 3 → 2 → 1 without skipping', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();

    const observed: (number | null)[] = [];
    // Sample countdown every second for 4 seconds after idle guard
    for (let s = 0; s <= 4; s++) {
      vi.advanceTimersByTime(s === 0 ? IDLE_GUARD_MS + TICK_MS : 1000);
      observed.push(sim.getCountdown());
    }

    expect(observed).toContain(3);
    expect(observed).toContain(2);
    expect(observed).toContain(1);
    expect(observed[observed.length - 1]).toBeNull(); // cleared after 3s
    sim.cleanup();
  });

  it('never goes negative', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();
    // Advance well past debounce
    vi.advanceTimersByTime(IDLE_GUARD_MS + DEBOUNCE_MS + 5000);
    const val = sim.getCountdown();
    expect(val === null || val > 0).toBe(true);
    sim.cleanup();
  });
});

describe('sync countdown — cancelCountdown (sync started)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('cancels before idle guard fires', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();
    vi.advanceTimersByTime(200); // still inside idle guard
    sim.cancelCountdown();
    vi.advanceTimersByTime(IDLE_GUARD_MS + TICK_MS * 5);
    expect(sim.getCountdown()).toBeNull();
    sim.cleanup();
  });

  it('cancels after countdown has started', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();
    vi.advanceTimersByTime(IDLE_GUARD_MS + TICK_MS + 1000); // countdown showing 2
    expect(sim.getCountdown()).toBe(2);
    sim.cancelCountdown();
    expect(sim.getCountdown()).toBeNull();
    sim.cleanup();
  });

  it('allows a new countdown cycle after cancel', () => {
    const sim = makeCountdownSim();
    sim.scheduleCountdown();
    vi.advanceTimersByTime(IDLE_GUARD_MS + TICK_MS + 1000);
    sim.cancelCountdown(); // sync started

    // User draws again after sync
    sim.scheduleCountdown();
    vi.advanceTimersByTime(IDLE_GUARD_MS + TICK_MS);
    expect(sim.getCountdown()).toBe(DEBOUNCE_MS / 1000);
    sim.cleanup();
  });
});

describe('sync countdown — multiple change bursts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('second burst after first sync resets correctly', () => {
    const sim = makeCountdownSim();

    // First burst → sync → cancel
    sim.scheduleCountdown();
    vi.advanceTimersByTime(IDLE_GUARD_MS + DEBOUNCE_MS + TICK_MS * 2);
    sim.cancelCountdown();

    // Second burst
    sim.scheduleCountdown();
    vi.advanceTimersByTime(IDLE_GUARD_MS + TICK_MS);
    expect(sim.getCountdown()).toBe(DEBOUNCE_MS / 1000);
    sim.cleanup();
  });

  it('countdown stays null between burst end and idle guard', () => {
    const sim = makeCountdownSim();

    // Two rapid changes 50ms apart
    sim.scheduleCountdown();
    vi.advanceTimersByTime(50);
    sim.scheduleCountdown();

    // 300ms after last change — still inside idle guard
    vi.advanceTimersByTime(300);
    expect(sim.getCountdown()).toBeNull();

    // 400ms after last change — idle guard has passed
    vi.advanceTimersByTime(IDLE_GUARD_MS - 300 + TICK_MS);
    expect(sim.getCountdown()).toBeGreaterThan(0);
    sim.cleanup();
  });
});
