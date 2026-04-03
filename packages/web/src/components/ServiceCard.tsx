import { StatusDot } from './StatusDot'
import type { Service } from '../lib/api'

interface ServiceCardProps {
  service: Service
  onServiceClick?: (name: string) => void
}

const TYPE_LABELS: Record<Service['type'], string> = {
  process: 'process',
  postgres: 'postgres',
  redis: 'redis',
  container: 'container',
  external: 'external',
}

const TYPE_COLORS: Record<Service['type'], string> = {
  process: 'text-blue border-blue/30 bg-blue/10',
  postgres: 'text-orange border-orange/30 bg-orange/10',
  redis: 'text-red border-red/30 bg-red/10',
  container: 'text-muted border-border bg-surface',
  external: 'text-muted border-border bg-surface',
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export function ServiceCard({ service, onServiceClick }: ServiceCardProps) {
  const detail = service.command ?? service.image ?? '—'

  return (
    <button
      type="button"
      onClick={() => onServiceClick?.(service.name)}
      className="w-full text-left rounded-lg border border-border bg-surface p-4 hover:border-blue/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue/50 cursor-pointer"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <StatusDot status={service.status} />
        <span className="font-semibold text-sm text-foreground flex-1 truncate">
          {service.name}
        </span>
        <span
          className={`text-xs px-2 py-0.5 rounded border font-mono ${TYPE_COLORS[service.type]}`}
        >
          {TYPE_LABELS[service.type]}
        </span>
      </div>

      {/* Details */}
      <div className="space-y-1 text-xs text-muted">
        <div className="truncate font-mono" title={detail}>
          {detail}
        </div>

        <div className="flex items-center gap-4">
          {service.port != null && (
            <span>
              :{service.port}
            </span>
          )}
          {service.proxyURL && (
            <a
              href={service.proxyURL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue hover:underline truncate"
              onClick={(e) => e.stopPropagation()}
            >
              {service.proxyURL}
            </a>
          )}
          {service.uptime != null && (
            <span className="ml-auto">{formatUptime(service.uptime)}</span>
          )}
        </div>
      </div>

      {/* Last log line */}
      {service.lastLog && (
        <div className="mt-3 pt-3 border-t border-border-subtle">
          <p className="font-mono text-xs text-muted truncate" title={service.lastLog}>
            {service.lastLog}
          </p>
        </div>
      )}
    </button>
  )
}
