import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPollingScheduler } from '../src/lib/polling';
afterEach(() => vi.useRealTimers());
describe('shared polling activity', () => {
  it('does no work while paused, catches up on resume, and slows on battery', () => {
    vi.useFakeTimers();
    const scheduler = createPollingScheduler({ setInterval, clearInterval });
    const work = vi.fn(); const stop = scheduler.add(work, 100);
    vi.advanceTimersByTime(100); expect(work).toHaveBeenCalledTimes(1);
    scheduler.update({ paused: true, battery: false });
    vi.advanceTimersByTime(1000); expect(work).toHaveBeenCalledTimes(1);
    scheduler.update({ paused: false, battery: true }); expect(work).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(299); expect(work).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1); expect(work).toHaveBeenCalledTimes(3);
    stop(); scheduler.update({ paused: false, battery: false }); vi.advanceTimersByTime(1000);
    expect(work).toHaveBeenCalledTimes(3);
  });
  it('does not start jobs added during suspend until resume', () => {
    vi.useFakeTimers(); const scheduler = createPollingScheduler({ setInterval, clearInterval });
    scheduler.update({ paused: true, battery: false }); const work = vi.fn(); const stop = scheduler.add(work, 100);
    vi.advanceTimersByTime(1000); expect(work).not.toHaveBeenCalled();
    scheduler.update({ paused: false, battery: false }); expect(work).toHaveBeenCalledTimes(1); stop();
  });
});
