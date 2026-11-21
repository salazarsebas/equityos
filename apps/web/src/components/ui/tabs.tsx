"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { cx } from "./cx";

export type TabItem = { id: string; label: string; content: ReactNode };

type TabsProps = {
  /** Names the tab list for assistive technology. */
  label: string;
  items: readonly TabItem[];
  defaultTabId?: string;
};

/**
 * Tabs following the ARIA tabs pattern with automatic activation: Left and Right move between tabs, Home and End
 * jump to the ends, and Tab moves from the active tab into its panel.
 */
export function Tabs({ label, items, defaultTabId }: TabsProps) {
  const baseId = useId();
  const [activeId, setActiveId] = useState(defaultTabId ?? items[0]?.id);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const active = items.find((item) => item.id === activeId);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((item) => item.id === activeId);
    const last = items.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = items[targets[event.key] ?? -1];
    if (!next) return;
    event.preventDefault();
    setActiveId(next.id);
    tabs.current.get(next.id)?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex gap-2 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)]"
      >
        {items.map((item) => {
          const selected = item.id === activeId;
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) tabs.current.set(item.id, node);
                else tabs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={selected ? `${baseId}-panel-${item.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(item.id)}
              className={cx(
                "h-10 shrink-0 border-b-2 px-2 text-base font-medium whitespace-nowrap -outline-offset-2 transition-colors duration-[120ms]",
                selected ? "border-accent text-primary" : "border-transparent text-secondary hover:text-primary",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {active ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active.id}`}
          aria-labelledby={`${baseId}-tab-${active.id}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the ARIA tabs pattern makes the panel a tab stop
          tabIndex={0}
          className="pt-6"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}
