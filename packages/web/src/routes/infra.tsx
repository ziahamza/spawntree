import { createFileRoute } from '@tanstack/react-router'
import { Database, Server } from 'lucide-react'
import { useInfra } from '../lib/api'
import { StatusDot } from '../components/StatusDot'
import type { Status } from '../components/StatusDot'

export const Route = createFileRoute('/infra')({
  component: InfraPage,
})

function toStatus(isRunning: boolean): Status {
  return isRunning ? 'running' : 'stopped'
}

function InfraCard({
  title,
  icon,
  status,
  details,
}: {
  title: string
  icon: React.ReactNode
  status: Status
  details: { label: string; value: string | number | undefined }[]
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="text-muted">{icon}</div>
        <h2 className="font-display font-semibold text-foreground">{title}</h2>
        <div className="ml-auto flex items-center gap-2">
          <StatusDot status={status} />
          <span className="text-sm text-muted capitalize">{status}</span>
        </div>
      </div>

      <dl className="space-y-2">
        {details
          .filter((d) => d.value != null)
          .map((d) => (
            <div key={d.label} className="flex items-center justify-between text-xs">
              <dt className="text-muted">{d.label}</dt>
              <dd className="font-mono text-foreground">{d.value}</dd>
            </div>
          ))}
      </dl>
    </div>
  )
}

function InfraPage() {
  const { data: infra, isLoading, error } = useInfra()

  if (isLoading) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="h-6 w-40 bg-surface rounded animate-pulse mb-6" />
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-40 rounded-lg bg-surface border border-border animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <p className="text-red text-sm">{error.message}</p>
      </div>
    )
  }

  // The API returns {postgres: [...instances], redis: {...} | null}
  const pgInstances = Array.isArray(infra?.postgres) ? infra.postgres : []
  const redis = infra?.redis

  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <h1 className="font-display text-2xl font-semibold text-foreground mb-6">Infrastructure</h1>

      <div className="grid gap-4 sm:grid-cols-2">
        {pgInstances.length > 0 ? (
          pgInstances.map((pg: any, i: number) => (
            <InfraCard
              key={i}
              title={`PostgreSQL ${pg.version || ''}`}
              icon={<Database className="w-5 h-5" />}
              status={toStatus(pg.running)}
              details={[
                { label: 'Version', value: pg.version },
                { label: 'Port', value: pg.port },
                { label: 'Container', value: pg.containerID?.slice(0, 12) },
                { label: 'Databases', value: pg.databases },
              ]}
            />
          ))
        ) : (
          <InfraCard
            title="PostgreSQL"
            icon={<Database className="w-5 h-5" />}
            status="stopped"
            details={[
              { label: 'Status', value: 'Not running' },
            ]}
          />
        )}

        <InfraCard
          title="Redis"
          icon={<Server className="w-5 h-5" />}
          status={redis ? toStatus(redis.running) : 'stopped'}
          details={redis ? [
            { label: 'Port', value: redis.port },
            { label: 'Container', value: redis.containerID?.slice(0, 12) },
          ] : [
            { label: 'Status', value: 'Not running' },
          ]}
        />
      </div>
    </div>
  )
}
