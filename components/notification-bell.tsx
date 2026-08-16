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

/** How often the bell asks. A worksheet takes minutes, so this is not a chat. */
const POLL_MS = 60_000

/**
 * Turns the base64url VAPID public key into the Uint8Array the API wants.
 *
 * `applicationServerKey` predates the platform having any interest in making
 * this convenient: it takes raw bytes, and the key travels as base64url, which
 * `atob` does not read. Hence the two character swaps and the padding.
 */
function decodeVapidKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)

  // Built over an explicit ArrayBuffer rather than `Uint8Array.from`, which
  // infers `ArrayBufferLike` and so could be backed by a SharedArrayBuffer.
  // `applicationServerKey` will not take one of those.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index)
  }

  return bytes
}

/**
 * spec.md:611's completion notification, both halves of it.
 *
 * The queue, the heartbeat and the status UI were all built and the piece that
 * makes them useful was not, so "safe to close this page" was true and useless:
 * a student had no way to learn a worksheet had finished except to come back
 * and look. On the trial tier, where extraction runs on a home GPU and can take
 * a while, that is the difference between a background job and one you babysit.
 *
 * The list is the half that always works. Push is offered on top, and every
 * reason it might not arrive is a reason to keep the list rather than to skip
 * it: permission can be declined or revoked, iOS delivers push only to a site
 * installed to the home screen, and a server with no VAPID keys cannot send at
 * all. In every one of those cases the bell still fills up.
 */
export default function NotificationBell() {
  const [items, setItems] = useState<Item[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [canPush, setCanPush] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Guards every write, so a poll in flight when the topbar unmounts does not
    // set state on a component that has gone.
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
        // A failed poll is not worth an error message. The next one is a minute
        // away, and a stale count beats the bell showing a complaint.
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  /*
   * Whether to offer push at all. Not whether it is granted: a student who has
   * already granted or already denied should not be asked again, and the
   * browser remembers which.
   *
   * Decided here rather than during render because every input is a browser
   * API: the server has no `navigator` and would render a different answer,
   * which is a hydration mismatch. Set from inside an async function rather
   * than straight out of the effect body, since a synchronous setState during
   * an effect is a second render pass before the browser has painted the first.
   */
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

  // Closing on an outside click and on Escape, which is what every other
  // popover on the web does and what a student will try.
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
        // Required to be true, and honestly so: this only ever shows a
        // notification, which is what the flag promises the browser.
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

    // Cleared here rather than after the round trip: opening the panel is the
    // student seeing them, and a badge that lingers for a request looks stuck.
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
        className="relative flex min-h-11 items-center rounded-xl border border-border px-2.5 text-sm transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => void openPanel()}
      >
        {/* Drawn, not an emoji: an emoji bell is a different picture on every
            platform and ignores the theme. */}
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
            <div className="border-b border-border p-2">
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
            <ul className="divide-y divide-border">
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
                          className="size-2 shrink-0 rounded-full bg-accent"
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
