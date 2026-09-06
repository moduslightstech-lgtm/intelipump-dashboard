import type { ReactNode } from 'react'

type Props = {
  children: ReactNode
  className?: string
}

/** Small SVG icon set for executive dashboard (no external icon pack). */
export function IconCurrency({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3v18M17 8a4 4 0 0 0-4-3H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconDroplet({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconReceipt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3Z" strokeLinejoin="round" />
      <path d="M9 8h6M9 12h6M9 16h4" strokeLinecap="round" />
    </svg>
  )
}

export function IconTicket({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 9V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4Z" strokeLinejoin="round" />
    </svg>
  )
}

export function IconBuilding({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 21V5a2 2 0 0 1 2-2h7l7 7v11" strokeLinejoin="round" />
      <path d="M9 21v-6h4v6M9 9h.01M13 9h.01M9 13h.01M13 13h.01" strokeLinecap="round" />
    </svg>
  )
}

export function IconWifi({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M5 12.5a9 9 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" strokeLinecap="round" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  )
}

export function IconWifiOff({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 3l18 18M16.7 11.2A9 9 0 0 0 5 12.5M9.2 15.4a5 5 0 0 1 3.3-1.3" strokeLinecap="round" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  )
}

export function IconAlert({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 9v4M12 17h.01M10.3 4.3 2.5 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" strokeLinejoin="round" />
    </svg>
  )
}

export function IconChart({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconInbox({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 13h4l2 3h4l2-3h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5Z" strokeLinejoin="round" />
      <path d="M4 13 6.5 5h11L20 13" strokeLinejoin="round" />
    </svg>
  )
}

export function IconCheck({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M20 7 10 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconTrendUp({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 16 10 10l4 4 6-6M14 8h6v6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export type IconComponent = (props: { className?: string }) => ReactNode
