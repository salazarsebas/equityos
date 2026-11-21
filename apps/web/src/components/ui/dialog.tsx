"use client";

import { type MouseEvent, type ReactNode, useEffect, useId, useRef } from "react";

type DialogProps = {
  open: boolean;
  /** Called when the dialog is dismissed with Escape, the backdrop or a close control. */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Actions, right-aligned. Put the confirming action last. */
  footer?: ReactNode;
};

/**
 * Modal dialog on the native `<dialog>` element, which provides the focus trap, Escape handling, the inert
 * background and focus return. Never open a dialog from inside another dialog.
 */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // A click whose target is the dialog element itself landed on the backdrop, outside the padded content.
  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled natively and reported through onClose
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={onBackdropClick}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-overlay bg-surface p-0 text-primary shadow-overlay backdrop:bg-scrim"
    >
      <div className="flex flex-col gap-3 p-6">
        <h2 id={titleId} className="text-lg font-medium">
          {title}
        </h2>
        <div className="text-base text-secondary">{children}</div>
        {footer ? <div className="mt-3 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </dialog>
  );
}
