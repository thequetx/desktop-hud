import { displayWeekDays, fmt } from '../lib/fmt';
import { sameDate } from '../lib/week';

/** The week as a row of days. Its first day follows the week-start setting
 *  (lib/fmt.ts); `weekStart` (the ISO Monday) is not needed to draw it. */
export function WeekStrip({ now }: { weekStart?: Date; now: Date }) {
  const f = fmt();
  return (
    <div className="weekstrip">
      {displayWeekDays(f, now).map((day, i) => {
        const today = sameDate(day, now);
        return (
          <span key={i} className={`weekstrip__d${today ? ' is-today' : ''}`}>
            <span className="weekstrip__dow">{f.dow(day).slice(0, 1).toUpperCase()}</span>
            <span className="weekstrip__num q-num">{day.getDate()}</span>
          </span>
        );
      })}
    </div>
  );
}
