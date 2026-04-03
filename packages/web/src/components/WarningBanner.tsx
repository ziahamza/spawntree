import { AlertTriangle } from 'lucide-react'

interface WarningBannerProps {
  cloneID: string
  path: string
  onRelink: (cloneID: string) => void
  onRemove: (cloneID: string) => void
  isRelinking?: boolean
  isRemoving?: boolean
}

export function WarningBanner({
  cloneID,
  path,
  onRelink,
  onRemove,
  isRelinking,
  isRemoving,
}: WarningBannerProps) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning-bg px-4 py-3">
      <AlertTriangle className="w-4 h-4 text-orange mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-orange font-medium">Missing clone</p>
        <p className="text-xs text-muted mt-0.5 font-mono truncate" title={path}>
          {path}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => onRelink(cloneID)}
          disabled={isRelinking || isRemoving}
          className="px-3 py-1.5 text-xs rounded-md border border-orange/40 bg-orange/10 text-orange hover:bg-orange/20 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-[32px]"
        >
          {isRelinking ? 'Relinking…' : 'Relink'}
        </button>
        <button
          onClick={() => onRemove(cloneID)}
          disabled={isRemoving || isRelinking}
          className="px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-red hover:border-red/40 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-[32px]"
        >
          {isRemoving ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  )
}
