import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from "react";
import { cx } from "./cx";
import { ChevronDownIcon } from "./icons";

type ControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

type FieldProps = {
  label: string;
  /** Persistent help under the control. */
  hint?: ReactNode;
  /** Validation message. Replaces the hint and marks the control invalid. */
  error?: ReactNode;
  /** Receives the id and ARIA attributes that tie the control to its label and message. */
  children: (control: ControlProps) => ReactNode;
  className?: string;
};

/** Label, control and one message line, wired together for assistive technology. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const message = error ?? hint;
  const messageId = `${id}-message`;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium text-primary">
        {label}
      </label>
      {children({
        id,
        ...(message ? { "aria-describedby": messageId } : {}),
        ...(error ? { "aria-invalid": true as const } : {}),
      })}
      {message ? (
        <p id={messageId} className={cx("text-xs", error ? "text-negative" : "text-secondary")}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

const control =
  "h-8 w-full rounded-md border border-strong bg-surface px-2 text-md text-primary md:text-base pointer-coarse:h-11 placeholder:text-tertiary disabled:cursor-not-allowed disabled:border-default disabled:bg-subtle disabled:text-disabled aria-invalid:border-negative";

/** Text input. Pass `inputMode="decimal"` and the `num` class for amounts. */
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(control, className)} />;
}

/** Native select with the system picker, restyled to match the other controls. */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx("relative", className)}>
      <select {...rest} className={cx(control, "appearance-none pr-8")}>
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-2 right-2 text-secondary" />
    </div>
  );
}

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode };

/** Native checkbox, restyled, with its label as one click target. */
export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  return (
    <label className={cx("inline-flex items-start gap-2 text-base text-primary", className)}>
      <span className="relative mt-0.5 inline-flex size-4 shrink-0">
        <input
          {...rest}
          type="checkbox"
          className="peer size-4 appearance-none rounded-sm border border-strong bg-surface checked:border-accent checked:bg-accent disabled:cursor-not-allowed disabled:border-default disabled:bg-subtle"
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute inset-0 hidden text-accent-fg peer-checked:block"
        >
          <path d="m4 8.25 2.75 2.75L12 5.5" />
        </svg>
      </span>
      <span className={rest.disabled ? "text-disabled" : undefined}>{label}</span>
    </label>
  );
}
