"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cx } from "./cx";

type Overflow = { left: boolean; right: boolean };

const EDGE = "pointer-events-none absolute inset-y-0 z-30 w-6 transition-opacity duration-[120ms]";
const SHADE = "color-mix(in srgb, var(--text-primary) 14%, transparent)";

type TableFrameProps = {
  label: string;
  maxHeight: string | undefined;
  children: ReactNode;
};

/**
 * Scroll region of a table. When columns are hidden past an edge it fades that edge, so that a narrow screen
 * shows there is more to scroll to. The region stays focusable so that it can be scrolled with the keyboard.
 */
export function TableFrame({ label, maxHeight, children }: TableFrameProps) {
  const scroller = useRef<HTMLElement>(null);
  const [overflow, setOverflow] = useState<Overflow>({ left: false, right: false });

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const left = node.scrollLeft > 1;
    const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setOverflow((previous) => (previous.left === left && previous.right === right ? previous : { left, right }));
  }, []);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const table = node.firstElementChild;
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="relative overflow-hidden rounded-lg border bg-surface">
      <section
        ref={scroller}
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
        onScroll={measure}
        style={maxHeight ? { maxHeight } : undefined}
        className="overflow-auto rounded-lg -outline-offset-2"
      >
        {children}
      </section>
      <div
        aria-hidden="true"
        className={cx(EDGE, "left-0", overflow.left ? "opacity-100" : "opacity-0")}
        style={{ backgroundImage: `linear-gradient(to right, ${SHADE}, transparent)` }}
      />
      <div
        aria-hidden="true"
        className={cx(EDGE, "right-0", overflow.right ? "opacity-100" : "opacity-0")}
        style={{ backgroundImage: `linear-gradient(to left, ${SHADE}, transparent)` }}
      />
    </div>
  );
}
