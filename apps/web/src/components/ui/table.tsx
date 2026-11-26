import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cx } from "./cx";
import { TableFrame } from "./table-frame";

type TableProps = {
  /** Names the scroll region for assistive technology. Use the caption text. */
  label: string;
  /** 32 px rows instead of 36 px, for wide comparison tables on desktop. */
  dense?: boolean;
  /** Caps the height (any CSS length) so the body scrolls under the sticky header. */
  maxHeight?: string;
  children: ReactNode;
};

/**
 * Data table. The frame is the only bordered container of its region. It scrolls horizontally when the columns
 * do not fit, with the first column pinned, and is keyboard focusable so that it can be scrolled without a
 * pointer. Rows are 44 px on touch devices.
 */
export function Table({ label, dense = false, maxHeight, children }: TableProps) {
  return (
    <TableFrame label={label} maxHeight={maxHeight}>
      <table
        data-dense={dense || undefined}
        className="group/table w-full border-separate border-spacing-0 text-left text-base pointer-coarse:[&_a]:inline-flex pointer-coarse:[&_a]:min-h-11 pointer-coarse:[&_a]:items-center"
      >
        {children}
      </table>
    </TableFrame>
  );
}

/** Title row of the table. Put the status tag and the data links for the whole table here, once. */
export function TableCaption({ children }: { children: ReactNode }) {
  return (
    <caption className="border-b px-4 py-3 text-left">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-medium text-primary">{children}</div>
    </caption>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return <thead>{children}</thead>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

/** Totals. Rendered in medium weight under a stronger rule. */
export function TableFoot({ children }: { children: ReactNode }) {
  return (
    <tfoot className="font-medium [&_td]:border-t [&_td]:border-strong [&_th]:border-t [&_th]:border-strong">
      {children}
    </tfoot>
  );
}

/** Cells take the row background so that the pinned first column covers what scrolls under it. */
export function TableRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      {...rest}
      className={cx(
        "bg-surface [tbody>&]:hover:bg-subtle [tbody>&:not(:last-child)>*]:border-b [&>*:first-child]:sticky [&>*:first-child]:left-0 [&>*:first-child]:pl-4 [&>*:last-child]:pr-4",
        className,
      )}
    />
  );
}

type CellProps = {
  /** Right-aligned with tabular figures. Set on every cell of a numeric column, header included. */
  numeric?: boolean;
};

const cell = "px-3 whitespace-nowrap bg-inherit";
const numericCell = "num text-right";

/** Column header: sentence case, with the unit when the whole column shares one, as in "Value (USD)". */
export function TableHeader({ numeric, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <th
      scope="col"
      {...rest}
      className={cx(
        cell,
        "sticky top-0 z-10 h-8 border-b bg-subtle text-xs font-medium text-secondary [&:first-child]:z-20",
        numeric && numericCell,
        className,
      )}
    />
  );
}

const body = "h-9 group-data-dense/table:h-8 pointer-coarse:h-11";

/** Identity of the row. The only body cell in medium weight. */
export function TableRowHeader({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="row" {...rest} className={cx(cell, body, "font-medium text-primary", className)} />;
}

export function TableCell({ numeric, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return <td {...rest} className={cx(cell, body, numeric && numericCell, className)} />;
}
