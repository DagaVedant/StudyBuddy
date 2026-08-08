/**
 * The StudyBuddy mark: four quarters, two filled, the split between what
 * you have got right and what you have not.
 */
export default function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
      <rect x="0" y="0" width="7" height="7" rx="1.5" fill="currentColor" />
      <rect x="9" y="0" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.35" />
      <rect x="0" y="9" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.35" />
      <rect x="9" y="9" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  )
}
