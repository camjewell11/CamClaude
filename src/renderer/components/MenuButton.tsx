import { SidebarIcon } from './Icons'

/** Opens the sidebar drawer on narrow screens; the badge counts sessions waiting on you. */
export function MenuButton({ onClick, waiting }: { onClick: () => void; waiting: number }) {
  return (
    <button className="icon-button menu-button" onClick={onClick} aria-label={waiting ? `Sessions, ${waiting} need you` : 'Sessions'}>
      <SidebarIcon size={18} />
      {waiting > 0 && <span className="menu-badge">{waiting}</span>}
    </button>
  )
}
