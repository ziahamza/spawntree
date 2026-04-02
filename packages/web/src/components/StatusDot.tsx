export type Status = 'running' | 'stopped' | 'crashed' | 'starting' | 'offline'

interface StatusDotProps {
  status: Status
  className?: string
}

export function StatusDot({ status, className = '' }: StatusDotProps) {
  if (status === 'offline') {
    return (
      <span
        className={`inline-block w-2 h-2 rounded-full border border-muted ${className}`}
        aria-label="offline"
      />
    )
  }

  const colorClass =
    status === 'running'
      ? 'bg-green'
      : status === 'starting'
        ? 'bg-orange animate-pulse'
        : 'bg-red' // stopped | crashed

  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colorClass} ${className}`}
      aria-label={status}
    />
  )
}
