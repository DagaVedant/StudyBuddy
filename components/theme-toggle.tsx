'use client'

import { useSyncExternalStore } from 'react'

import { THEME_STORAGE_KEY } from '@/lib/theme-script'

type Theme = 'light' | 'dark'

// The key and the pre-paint script moved to lib/theme-script.ts so
// next.config.ts can hash the script for the CSP without importing this client
// component. Re-exported because both names were part of this module's surface.
export { THEME_STORAGE_KEY, themeInitScript } from '@/lib/theme-script'

function resolveTheme(): Theme {
  const explicit = document.documentElement.getAttribute('data-theme')
  if (explicit === 'light' || explicit === 'dark') return explicit
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', onChange)

  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })

  return () => {
    media.removeEventListener('change', onChange)
    observer.disconnect()
  }
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore<Theme>(subscribe, resolveTheme, () => 'light')
  const isDark = theme === 'dark'

  function toggle() {
    const next: Theme = resolveTheme() === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {}
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Dark mode"
      onClick={toggle}
      className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer touch-manipulation items-center rounded-full border border-border bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span
        aria-hidden="true"
        className="theme-knob pointer-events-none absolute inset-y-0.5 left-0.5 grid size-5 place-items-center rounded-full bg-accent text-accent-fg shadow-sm"
      >
        <svg
          viewBox="0 0 24 24"
          className="theme-sun absolute size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 1.5v2M12 20.5v2M22.5 12h-2M3.5 12h-2M19.4 4.6l-1.4 1.4M6 18l-1.4 1.4M19.4 19.4L18 18M6 6L4.6 4.6" />
        </svg>

        <svg viewBox="0 0 24 24" className="theme-moon absolute size-3" fill="currentColor">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      </span>
    </button>
  )
}
