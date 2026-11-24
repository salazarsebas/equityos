import { formatCount } from "@/lib/format";
import type { DailyCount } from "@/server/registry";

const WIDTH = 640;
const HEIGHT = 160;
const AXIS = 20;
const DAY_MS = 86_400_000;

/** Every UTC day from the first to the last of the series, with zero for a day without events. */
function fillDays(series: readonly DailyCount[]): DailyCount[] {
  const counts = new Map(series.map(({ day, count }) => [day, count]));
  const first = series[0];
  const last = series.at(-1);
  if (first === undefined || last === undefined) return [];
  const days: DailyCount[] = [];
  for (let time = Date.parse(first.day); time <= Date.parse(last.day); time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    days.push({ day, count: counts.get(day) ?? 0 });
  }
  return days;
}

/**
 * Counts per UTC day as thin bars on one axis, with no border, one baseline and the largest count marked on the
 * right. Each bar names its day and count on hover, and the same numbers are in a table for assistive
 * technology.
 */
export function DailyBars({ title, series }: { title: string; series: readonly DailyCount[] }) {
  const days = fillDays(series);
  const max = Math.max(1, ...days.map(({ count }) => count));
  const step = WIDTH / Math.max(days.length, 1);
  const plot = HEIGHT - AXIS;
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-40 w-full" role="img" aria-label={title}>
        <line x1={0} x2={WIDTH} y1={plot} y2={plot} className="stroke-[var(--border-strong)]" strokeWidth={1} />
        <line x1={0} x2={WIDTH} y1={0.5} y2={0.5} className="stroke-[var(--border)]" strokeWidth={1} />
        <text x={WIDTH} y={12} textAnchor="end" className="fill-[var(--text-secondary)] text-xs">
          {formatCount(BigInt(max))}
        </text>
        {days.map(({ day, count }, index) => {
          const height = (count / max) * (plot - 16);
          return (
            <rect
              key={day}
              x={index * step + step * 0.2}
              y={plot - height}
              width={step * 0.6}
              height={height}
              rx={1}
              className="fill-[var(--text-secondary)]"
            >
              <title>{`${day}: ${count}`}</title>
            </rect>
          );
        })}
        <text x={0} y={HEIGHT - 4} className="fill-[var(--text-secondary)] text-xs">
          {days[0]?.day}
        </text>
        <text x={WIDTH} y={HEIGHT - 4} textAnchor="end" className="fill-[var(--text-secondary)] text-xs">
          {days.at(-1)?.day}
        </text>
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {days.map(({ day, count }) => (
            <tr key={day}>
              <th scope="row">{day}</th>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
