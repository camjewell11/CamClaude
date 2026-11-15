// Touch gestures for phones: what a native app does that a web page doesn't by default.
//
// - Drag down, or tap outside the message box, to hide the keyboard.
// - Swipe right to open the sidebar and left to close it; the drawer follows the finger.
// - Long press for the menu that a right-click opens on the desktop.
// - Swipe a bottom sheet (a dialog on a phone) down to close it.
// - The phone's back gesture or button closes the sidebar instead of leaving the page.

import { useEffect, useRef, type RefObject } from 'react'

/** A finger, not a mouse: phones and tablets. */
export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
/** The phone layout, where the sidebar is a drawer and dialogs are bottom sheets (see styles.css). */
const isNarrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches
const isRemote = () => document.documentElement.classList.contains('remote')

/** How far a finger moves before a gesture commits to an axis. */
const SLOP = 10
/** px per ms: a flick this fast decides the gesture whatever the distance. */
const FLICK = 0.4

const FIELDS = 'textarea, input, select, [contenteditable="true"]'

function focusedField(): HTMLElement | null {
  const el = document.activeElement
  return el instanceof HTMLElement && el.matches(FIELDS) ? el : null
}

/** Hides the on-screen keyboard by taking focus away from the text field. */
export function hideKeyboard(): void {
  focusedField()?.blur()
}

/** True when something under the finger can still scroll sideways the way the finger moves. */
function scrollsSideways(target: EventTarget | null, dx: number): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue
    const ox = getComputedStyle(el).overflowX
    if (ox !== 'auto' && ox !== 'scroll') continue
    // A finger moving right scrolls content toward its start.
    if (dx > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true
  }
  return false
}

/** Speed of the last stretch of a drag, from the two most recent samples. */
class Velocity {
  private samples: { p: number; t: number }[] = []
  add(p: number): void {
    this.samples.push({ p, t: performance.now() })
    if (this.samples.length > 4) this.samples.shift()
  }
  get(): number {
    const a = this.samples[0]
    const b = this.samples.at(-1)
    if (!a || !b || b.t - a.t < 1) return 0
    return (b.p - a.p) / (b.t - a.t)
  }
}

/**
 * Inside `root`: dragging down, or tapping anywhere that isn't a control, hides the keyboard.
 * A drag that starts in a text field that has scrolled down is left alone, so you can still
 * scroll a long draft.
 */
export function useKeyboardDismiss(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!isTouch()) return
    // Listens on the document, because `root` might not be rendered yet when this runs.
    const el = document
    let s: { x: number; y: number; t: number; target: Element; moved: boolean } | null = null

    const start = (e: TouchEvent) => {
      const p = e.touches[0]
      const inside = e.target instanceof Element && !!root.current?.contains(e.target)
      s = e.touches.length === 1 && inside ? { x: p.clientX, y: p.clientY, t: Date.now(), target: e.target as Element, moved: false } : null
    }
    const move = (e: TouchEvent) => {
      if (!s) return
      const p = e.touches[0]
      const dx = p.clientX - s.x
      const dy = p.clientY - s.y
      if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) s.moved = true
      if (dy > 2 * SLOP && dy > Math.abs(dx) && focusedField()) {
        const box = s.target.closest('textarea')
        if (!box || box.scrollTop <= 0) hideKeyboard()
        s = null
      }
    }
    const end = () => {
      if (s && !s.moved && Date.now() - s.t < 350 && focusedField()) {
        const onControl = s.target.closest(`${FIELDS}, button, a, label, summary, [role="button"], .composer`)
        const selecting = !!window.getSelection()?.toString()
        if (!onControl && !selecting) hideKeyboard()
      }
      s = null
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', end, { passive: true })
    el.addEventListener('touchcancel', end, { passive: true })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [root])
}

/**
 * Swipe right anywhere to open the sidebar drawer, and left to close it. The drawer follows the
 * finger; letting go past halfway, or with a flick, finishes the move. Code blocks and tables that
 * can still scroll sideways keep the swipe for themselves.
 */
export function useDrawerSwipe(app: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void): void {
  const openRef = useRef(open)
  openRef.current = open
  const setRef = useRef(setOpen)
  setRef.current = setOpen

  useEffect(() => {
    if (!isTouch()) return
    type Drag = { x: number; y: number; target: EventTarget | null; dragging: boolean; offset: number; width: number; v: Velocity }
    let g: Drag | null = null
    const parts = () => ({
      sidebar: app.current?.querySelector<HTMLElement>('.sidebar') ?? null,
      scrim: app.current?.querySelector<HTMLElement>('.scrim') ?? null,
    })

    const start = (e: TouchEvent) => {
      g = null
      if (e.touches.length !== 1 || !isNarrow()) return
      if (document.querySelector('.overlay, .menu, .lightbox')) return // a dialog, menu, or photo is open
      if (e.target instanceof Element && e.target.closest(FIELDS)) return
      const { sidebar } = parts()
      if (!sidebar) return
      const p = e.touches[0]
      g = { x: p.clientX, y: p.clientY, target: e.target, dragging: false, offset: 0, width: sidebar.offsetWidth, v: new Velocity() }
    }

    const move = (e: TouchEvent) => {
      if (!g) return
      const p = e.touches[0]
      const dx = p.clientX - g.x
      const dy = p.clientY - g.y
      if (!g.dragging) {
        const wanted = openRef.current ? dx < 0 : dx > 0
        const sideways = Math.abs(dx) > Math.abs(dy)
        if (!wanted || !sideways || (!openRef.current && scrollsSideways(g.target, dx))) {
          if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) g = null // it's a scroll, not a swipe
          return
        }
        if (e.cancelable) e.preventDefault() // keep the page from starting a scroll meanwhile
        if (Math.abs(dx) < SLOP) return
        g.dragging = true
        hideKeyboard()
        app.current?.classList.add('drawer-dragging')
        const { sidebar } = parts()
        if (sidebar) sidebar.style.transition = 'none'
      }
      if (e.cancelable) e.preventDefault()
      // The drawer's position: -width is fully closed, 0 fully open.
      g.offset = Math.max(-g.width, Math.min(0, openRef.current ? dx : -g.width + dx))
      g.v.add(p.clientX)
      const { sidebar, scrim } = parts()
      if (sidebar) sidebar.style.transform = `translateX(${g.offset}px)`
      if (scrim) scrim.style.opacity = String(1 + g.offset / g.width)
    }

    const end = () => {
      const d = g
      g = null
      if (!d?.dragging) return
      const v = d.v.get()
      const shouldOpen = v > FLICK ? true : v < -FLICK ? false : d.offset > -d.width / 2
      const { sidebar, scrim } = parts()
      // Clearing the inline styles hands the position back to the CSS, which animates from where
      // the finger left it to where the class puts it.
      if (sidebar) {
        sidebar.style.transition = ''
        sidebar.style.transform = ''
      }
      if (scrim) scrim.style.opacity = ''
      app.current?.classList.remove('drawer-dragging')
      setRef.current(shouldOpen)
    }

    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end, { passive: true })
    document.addEventListener('touchcancel', end, { passive: true })
    return () => {
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', end)
      document.removeEventListener('touchcancel', end)
    }
  }, [app])
}

/**
 * While `active`, the phone's back gesture or button calls `close` instead of leaving the page.
 * Only in a phone's browser: the desktop window has no back button.
 */
export function useBackToClose(active: boolean, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active || !isRemote()) return
    history.pushState({ camclaudeOverlay: true }, '')
    let popped = false
    const onPop = () => {
      popped = true
      closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Closed some other way (a tap): drop the history entry this opened.
      if (!popped && history.state?.camclaudeOverlay) history.back()
    }
  }, [active])
}

/**
 * Long press opens a menu, the touch version of a right-click. Spread the result on the element;
 * it also handles the right-click itself, and suppresses the tap that would otherwise follow.
 */
export function useLongPress(onPress: (at: { x: number; y: number }) => void) {
  const timer = useRef<number | undefined>(undefined)
  const touching = useRef(false)
  const fired = useRef(false)
  const origin = useRef({ x: 0, y: 0 })
  const fire = (at: { x: number; y: number }) => {
    fired.current = true
    navigator.vibrate?.(10) // Android; iOS browsers ignore it
    onPress(at)
  }
  const cancel = () => window.clearTimeout(timer.current)
  return {
    onTouchStart: (e: React.TouchEvent) => {
      touching.current = true
      fired.current = false
      cancel()
      if (e.touches.length !== 1) return
      origin.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      timer.current = window.setTimeout(() => fire(origin.current), 450)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const p = e.touches[0]
      if (Math.hypot(p.clientX - origin.current.x, p.clientY - origin.current.y) > SLOP) cancel()
    },
    onTouchEnd: (e: React.TouchEvent) => {
      cancel()
      touching.current = false
      if (fired.current) e.preventDefault() // no tap after a long press
    },
    onTouchCancel: () => {
      cancel()
      touching.current = false
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      cancel()
      // Android fires this on a long press as well; open the menu only once.
      if (touching.current && fired.current) return
      fire({ x: e.clientX, y: e.clientY })
    },
  }
}

/**
 * Lets a bottom sheet be dragged down and closed. A drag that starts in the sheet's scrolling body
 * only moves the sheet once the body is scrolled to its top.
 */
export function useSheetDismiss(sheet: RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const el = sheet.current
    if (!el || !isTouch()) return
    let g: { y: number; x: number; dragging: boolean; dy: number; v: Velocity } | null = null

    const start = (e: TouchEvent) => {
      g = null
      if (e.touches.length !== 1 || !isNarrow()) return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest(FIELDS)) return
      const body = t?.closest('.modal-body')
      if (body && body.scrollTop > 0) return
      g = { x: e.touches[0].clientX, y: e.touches[0].clientY, dragging: false, dy: 0, v: new Velocity() }
    }
    const move = (e: TouchEvent) => {
      if (!g) return
      const p = e.touches[0]
      const dx = p.clientX - g.x
      const dy = p.clientY - g.y
      if (!g.dragging) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
        if (dy <= 0 || Math.abs(dx) > dy) {
          g = null
          return
        }
        g.dragging = true
        hideKeyboard()
        el.style.transition = 'none'
      }
      if (e.cancelable) e.preventDefault()
      g.dy = Math.max(0, dy)
      g.v.add(p.clientY)
      el.style.transform = `translateY(${g.dy}px)`
    }
    const end = () => {
      const d = g
      g = null
      if (!d?.dragging) return
      const close = d.v.get() > FLICK || d.dy > Math.min(140, el.offsetHeight / 3)
      el.style.transition = 'transform 0.18s ease'
      el.style.transform = close ? 'translateY(100%)' : ''
      if (close) window.setTimeout(() => closeRef.current(), 160)
      else window.setTimeout(() => (el.style.transition = ''), 200)
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end, { passive: true })
    el.addEventListener('touchcancel', end, { passive: true })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [sheet])
}
