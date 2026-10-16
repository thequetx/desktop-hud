// One activity policy for renderer polling. Lock/suspend clears timers;
// resuming catches up immediately, and battery power triples the interval.
export interface ActivityState { paused: boolean; battery: boolean }
export function createPollingScheduler(timers: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (id: any) => void }) {
  let state: ActivityState = { paused: false, battery: false };
  const jobs = new Set<{ fn: () => void; ms: number; timer: unknown }>();
  function arm(job: { fn: () => void; ms: number; timer: unknown }) {
    if (job.timer != null) timers.clearInterval(job.timer);
    job.timer = state.paused ? null : timers.setInterval(job.fn, job.ms * (state.battery ? 3 : 1));
  }
  return {
    add(fn: () => void, ms: number) {
      const job = { fn, ms, timer: null as unknown };
      jobs.add(job); arm(job);
      return () => { jobs.delete(job); if (job.timer != null) timers.clearInterval(job.timer); job.timer = null; };
    },
    update(next: ActivityState) {
      if (state.paused === next.paused && state.battery === next.battery) return;
      const resumed = state.paused && !next.paused;
      state = next;
      for (const job of jobs) { arm(job); if (resumed) job.fn(); }
    },
  };
}
const scheduler = createPollingScheduler({ setInterval: (fn, ms) => window.setInterval(fn, ms), clearInterval: id => window.clearInterval(id) });
if (typeof window !== 'undefined' && window.wd) {
  let eventSeen = false;
  window.wd.onActivity?.(state => { eventSeen = true; scheduler.update(state); });
  void window.wd.activityState?.().then(state => { if (!eventSeen) scheduler.update(state); }).catch(() => {});
}
export const setPollingInterval = scheduler.add;
export const clearPollingInterval = (stop: () => void): void => stop();
