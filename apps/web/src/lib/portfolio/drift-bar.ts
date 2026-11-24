/**
 * Geometry of the diverging drift bar: a track centred on zero, a bar from the centre to the drift, and a tick
 * at the threshold on each side. Every position is a share of the track width in hundredths of a percent,
 * computed on integers and rounded toward the centre, so that a bar is never drawn longer than its drift.
 */
export interface DriftBarGeometry {
  /** Left edge of the bar, as a CSS percentage. */
  readonly left: string;
  readonly width: string;
  /** Left edge of the threshold ticks below and above zero. */
  readonly lowerTick: string;
  readonly upperTick: string;
  /** True when the absolute drift reaches the threshold. */
  readonly beyond: boolean;
}

/**
 * The drift that half the track stands for: the threshold times the smallest integer of at least 2 that also
 * covers the largest drift of the table. The ticks then sit at half the half-track or closer to the centre, and
 * every bar of one table shares the scale.
 */
export function driftScaleBps(maxAbsDriftBps: number, thresholdBps: number): number {
  return thresholdBps * Math.max(2, Math.ceil(maxAbsDriftBps / thresholdBps));
}

/** `1234` hundredths of a percent as `12.34%`. */
function percent(hundredths: number): string {
  return `${Math.trunc(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}%`;
}

const CENTRE = 5_000;

export function driftBar(driftBps: number, thresholdBps: number, scaleBps: number): DriftBarGeometry {
  const magnitude = Math.min(Math.abs(driftBps), scaleBps);
  const width = Math.floor((magnitude * CENTRE) / scaleBps);
  const tick = Math.floor((thresholdBps * CENTRE) / scaleBps);
  return {
    left: percent(driftBps < 0 ? CENTRE - width : CENTRE),
    width: percent(width),
    lowerTick: percent(CENTRE - tick),
    upperTick: percent(CENTRE + tick),
    beyond: Math.abs(driftBps) >= thresholdBps,
  };
}
