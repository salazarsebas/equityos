import type { ReactNode } from "react";

/** The icon set: 16 px, 1.5 px stroke, decorative. The text next to an icon carries the meaning. */
function Icon({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M6.5 3.5h-3v9h9v-3M9.5 3.5h3v3M12.5 3.5 7.5 8.5" />
    </Icon>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2.25 1.5" />
    </Icon>
  );
}

export function WarningIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M8 2.25 14.25 13H1.75L8 2.25ZM8 6.5v3M8 11.25v.01" />
    </Icon>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m4 6 4 4 4-4" />
    </Icon>
  );
}

export function SunIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
    </Icon>
  );
}

export function MoonIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M13.25 9.4A5.75 5.75 0 0 1 6.6 2.75a5.75 5.75 0 1 0 6.65 6.65Z" />
    </Icon>
  );
}

export function WalletIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M2.5 4.75v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1h-9a1 1 0 0 1-1-1Zm0 0a1 1 0 0 1 1-1h7.75M11 9.25v.01" />
    </Icon>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M5.75 5.75h6.5v6.5h-6.5zM10.25 5.75v-2h-6.5v6.5h2" />
    </Icon>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Icon>
  );
}

export function DisconnectIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M6.5 2.75h-3v10.5h3M10 5.25 12.75 8 10 10.75M12.75 8h-6.5" />
    </Icon>
  );
}
