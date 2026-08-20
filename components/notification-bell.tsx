'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

interface Item {
  id: string
  kind: string
  title: string
  body: string
  href: string
  read: boolean
  createdAt: string
}

const POLL_MS = 60_000

function decodeVapidKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)

  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index)
  }

  return bytes
}

export default function NotificationBell() {
  const [items, setItems] = useState<Item[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [canPush, setCanPush] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const response = await fetch('/api/notifications')
        if (cancelled || !response.ok) return

        const data = (await response.json()) as {
          unread: number
          notifications: Item[]
        }
        if (cancelled) return

        setItems(data.notifications)
        setUnread(data.unread)
      } catch {
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function offerPush() {
      const usable =
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window &&
        Notification.permission === 'default' &&
        Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)

      if (usable && !cancelled) setCanPush(true)
    }

    void offerPush()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  async function subscribe() {
    try {
      const permission = await Notification.requestPermission()
      setCanPush(false)
      if (permission !== 'granted') return

      const registration = await navigator.serviceWorker.register('/sw.js')
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
        ),
      })

      await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })
    } catch (error) {
      console.warn('[notifications] could not subscribe:', error)
    }
  }

  async function openPanel() {
    setOpen((wasOpen) => !wasOpen)

    if (open || unread === 0) return

    setUnread(0)
    setItems((current) => current.map((item) => ({ ...item, read: true })))
    await fetch('/api/notifications', { method: 'POST' }).catch(() => {})
  }

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={
          unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
        }
        className="relative flex min-h-11 items-center rounded-xl px-2.5 text-sm transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => void openPanel()}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-[18px]"
        >
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[0.625rem] font-semibold leading-4 text-accent-fg"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="card absolute right-0 z-50 mt-2 max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-2">
          {canPush && (
            <div className="p-2">
              <p className="text-sm text-pretty">
                Get told when a worksheet finishes, even with this tab closed.
              </p>
              <button
                type="button"
                className="btn btn-secondary mt-2 sm:w-auto sm:px-4"
                onClick={() => void subscribe()}
              >
                Turn on notifications
              </button>
            </div>
          )}

          {items.length === 0 ? (
            <p className="p-3 text-sm text-muted text-pretty">
              Nothing yet. When a worksheet finishes being read, it turns up
              here.
            </p>
          ) : (
            <ul className="">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-lg p-2.5 hover:bg-accent/8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {item.title}
                      </span>
                      {!item.read && (
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 bg-accent"
                        />
                      )}
                    </span>
                    <span className="hint block text-pretty">{item.body}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
