/**
 * Minimal inline SVG icons — no external dependency.
 * Stroke-based outline style to match EG-Desk Surface aesthetic.
 */

interface IconProps {
  className?: string
}

function baseProps(className?: string) {
  return {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
}

export function Search({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

export function Bell({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

export function Map({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
      <path d="M9 4v16" />
      <path d="M15 6v16" />
    </svg>
  )
}

export function ChatBubble({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export function NoteCard({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M6 3h9l4 4v11a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" />
      <path d="M15 3v5h5" />
      <path d="M8 12h8" />
      <path d="M8 16h5" />
    </svg>
  )
}

export function FolderStack({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 20h16a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9L10 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

export function Plus({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function Trash({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function Globe({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15 15 0 0 1 0 20" />
      <path d="M12 2a15 15 0 0 0 0 20" />
    </svg>
  )
}

export function Timer({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M10 2h4" />
      <path d="M12 14v-4" />
      <circle cx="12" cy="14" r="8" />
    </svg>
  )
}

export function Bag({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 7h16l-1.2 12.3a2 2 0 0 1-2 1.7H7.2a2 2 0 0 1-2-1.7L4 7Z" />
      <path d="M8 7V5a4 4 0 0 1 8 0v2" />
    </svg>
  )
}

export function Code({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </svg>
  )
}

export function Users({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

export function Pen({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  )
}

export function Pencil({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 19l7-7 3 3-7 7-3-3z" />
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
      <path d="M2 2l7.586 7.586" />
      <circle cx="11" cy="11" r="2" />
    </svg>
  )
}

export function Hand({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
      <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  )
}

export function Square({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  )
}

export function Arrow({ className }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(className)}>
      <path d="M5 3l6.5 17 2-7 7-2L5 3z" />
    </svg>
  )
}
