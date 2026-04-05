import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, ExternalLink, Link2, Loader2, Settings2, Square, Wand2, X, XCircle } from 'lucide-react'
import {
  useSaveConfig,
  useSuggestConfig,
  useStartConfigPreview,
  useStopConfigPreview,
  useTestConfig,
  useEnvDetail,
  type ConfigServiceSuggestion,
  type ConfigSignal,
  type ConfigTestServiceResult,
} from '../lib/api'

interface AddConfigDialogProps {
  open: boolean
  repoPath: string | null
  onOpenChange: (open: boolean) => void
}

type EditorTab = 'suggested' | 'yaml'

type ServiceDraft = ConfigServiceSuggestion

function starterServices(): ServiceDraft[] {
  return [
    {
      id: 'starter-app',
      name: 'app',
      type: 'process',
      command: 'npm run dev',
      port: 3000,
      healthcheckUrl: 'http://localhost:${PORT}',
      selected: true,
      reason: 'starter config',
      source: '.',
    },
  ]
}

function yamlQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function servicesToYaml(services: ServiceDraft[]) {
  const enabled = services.filter((service) => service.selected)
  if (enabled.length === 0) {
    return 'services: {}\n'
  }

  const lines = ['services:']
  for (const service of enabled) {
    lines.push(`  ${service.name}:`)
    lines.push(`    type: ${service.type}`)
    if (service.type === 'process' && service.command) {
      lines.push(`    command: ${yamlQuote(service.command)}`)
    }
    if (service.type === 'container' && service.image) {
      lines.push(`    image: ${yamlQuote(service.image)}`)
    }
    if ((service.type === 'process' || service.type === 'container') && service.port) {
      lines.push(`    port: ${service.port}`)
    }
    if ((service.type === 'process' || service.type === 'container') && service.healthcheckUrl) {
      lines.push('    healthcheck:')
      lines.push(`      url: ${yamlQuote(service.healthcheckUrl)}`)
    }
    if (service.dependsOn && service.dependsOn.length > 0) {
      lines.push('    depends_on:')
      for (const dependency of service.dependsOn) {
        lines.push(`      - ${dependency}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

function normalizeServices(services: ConfigServiceSuggestion[] | undefined) {
  if (!services || services.length === 0) {
    return starterServices()
  }
  return services.map((service) => ({
    ...service,
    dependsOn: service.dependsOn ?? [],
  }))
}

function signalTone(kind: string) {
  switch (kind) {
    case 'toolchain':
      return 'text-blue border-blue/30 bg-blue/10'
    case 'workspace':
      return 'text-green border-green/30 bg-green/10'
    case 'compose':
      return 'text-orange border-orange/30 bg-orange/10'
    default:
      return 'text-muted border-border bg-background'
  }
}

function sourceLabel(source?: string) {
  return source && source !== '.' ? source : 'repo root'
}

function requiresHealthcheck(service: ServiceDraft) {
  return service.selected && (service.type === 'process' || service.type === 'container')
}

function previewURLForService(service: { url?: string; type?: string }) {
  if (service.type === 'postgres' || service.type === 'redis') return null
  if (!service.url) return null
  return /^https?:\/\//.test(service.url) ? service.url : null
}

function LivePreviewLogs({
  repoID,
  envID,
  repoPath,
  service,
}: {
  repoID: string
  envID: string
  repoPath?: string
  service: string
}) {
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    const params = new URLSearchParams()
    params.set('service', service)
    params.set('lines', '20')
    if (repoPath) params.set('repoPath', repoPath)
    const es = new EventSource(`/api/v1/repos/${repoID}/envs/${envID}/logs?${params.toString()}`)
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data)
        const line = typeof parsed?.line === 'string' ? parsed.line : String(event.data)
        setLines((prev) => [...prev.slice(-19), line])
      } catch {
        setLines((prev) => [...prev.slice(-19), String(event.data)])
      }
    }
    es.onerror = () => {
      es.close()
    }
    return () => es.close()
  }, [repoID, envID, repoPath, service])

  return (
    <pre className="text-[11px] font-mono text-foreground bg-background rounded-md p-2 overflow-auto max-h-40 whitespace-pre-wrap">
      {lines.length > 0 ? lines.join('\n') : 'Waiting for logs…'}
    </pre>
  )
}

export function AddConfigDialog({ open, repoPath, onOpenChange }: AddConfigDialogProps) {
  const [services, setServices] = useState<ServiceDraft[]>(starterServices())
  const [signals, setSignals] = useState<ConfigSignal[]>([])
  const [saveInRepo, setSaveInRepo] = useState(true)
  const [lastVerifiedContent, setLastVerifiedContent] = useState<string | null>(null)
  const [tab, setTab] = useState<EditorTab>('suggested')
  const [rawContent, setRawContent] = useState(servicesToYaml(starterServices()))
  const [rawDirty, setRawDirty] = useState(false)
  const [preview, setPreview] = useState<{ previewId: string; repoID: string; envID: string; repoPath?: string } | null>(null)

  const suggestConfig = useSuggestConfig()
  const testConfig = useTestConfig()
  const startPreview = useStartConfigPreview()
  const stopPreview = useStopConfigPreview()
  const saveConfig = useSaveConfig()
  const previewEnv = useEnvDetail(preview?.repoID ?? '', preview?.envID ?? '', preview?.repoPath)

  const generatedContent = useMemo(() => servicesToYaml(services), [services])
  const currentContent = rawDirty ? rawContent : generatedContent

  useEffect(() => {
    if (!rawDirty) {
      setRawContent(generatedContent)
    }
  }, [generatedContent, rawDirty])

  useEffect(() => {
    if (!open) return

    setSaveInRepo(true)
    setLastVerifiedContent(null)
    setTab('suggested')
    setSignals([])
    setServices(starterServices())
    setRawDirty(false)
    setRawContent(servicesToYaml(starterServices()))
    setPreview(null)

    if (!repoPath) return

    let cancelled = false
    suggestConfig
      .mutateAsync({ repoPath })
      .then((result) => {
        if (cancelled) return
        const nextServices = normalizeServices(result.services)
        setSignals(result.signals ?? [])
        setServices(nextServices)
        setRawDirty(false)
        setRawContent(servicesToYaml(nextServices))
      })
      .catch(() => {
        if (cancelled) return
        setSignals([])
      })

    return () => {
      cancelled = true
    }
  }, [open, repoPath])

  useEffect(() => {
    if (open) return
    if (!preview?.previewId) return
    void stopPreview.mutateAsync({ previewId: preview.previewId }).catch(() => {})
    setPreview(null)
  }, [open, preview?.previewId, stopPreview])

  const verificationSummary = useMemo(() => {
    if (!testConfig.data?.ok) return null
    return testConfig.data.serviceNames.join(', ')
  }, [testConfig.data])

  const missingHealthchecks = useMemo(
    () =>
      services
        .filter((service) => requiresHealthcheck(service) && !service.healthcheckUrl?.trim())
        .map((service) => service.name),
    [services],
  )

  const canSave =
    !!repoPath &&
    lastVerifiedContent === currentContent &&
    !!preview &&
    previewEnv.data?.services.every((service) => service.status === 'running') &&
    !saveConfig.isPending &&
    missingHealthchecks.length === 0

  function updateService(id: string, patch: Partial<ServiceDraft>) {
    setServices((prev) => prev.map((service) => (service.id === id ? { ...service, ...patch } : service)))
    setRawDirty(false)
    setLastVerifiedContent(null)
  }

  async function handleTest() {
    if (!repoPath) return
    const result = await testConfig.mutateAsync({ repoPath, content: currentContent })
    if (result.ok) {
      setLastVerifiedContent(currentContent)
    }
  }

  async function handlePreview() {
    if (!repoPath) return
    if (preview?.previewId) {
      await stopPreview.mutateAsync({ previewId: preview.previewId }).catch(() => {})
      setPreview(null)
    }
    const result = await startPreview.mutateAsync({ repoPath, content: currentContent })
    setPreview({
      previewId: result.previewId,
      repoID: result.env.repoId,
      envID: result.env.envId,
      repoPath: result.env.repoPath,
    })
    setLastVerifiedContent(currentContent)
  }

  async function handleStopPreview() {
    if (!preview?.previewId) return
    await stopPreview.mutateAsync({ previewId: preview.previewId }).catch(() => {})
    setPreview(null)
  }

  async function handleSave() {
    if (!repoPath || !canSave) return
    await saveConfig.mutateAsync({
      repoPath,
      content: currentContent,
      saveMode: saveInRepo ? 'repo' : 'global',
    })
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(94vw,980px)] max-h-[88vh] bg-surface border border-border rounded-xl shadow-2xl p-6 focus:outline-none overflow-hidden flex flex-col">
          <div className="flex items-center justify-between mb-5 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-blue" />
              <Dialog.Title className="font-display font-semibold text-sm text-foreground">
                Add Config
              </Dialog.Title>
            </div>
            <Dialog.Close className="text-muted hover:text-foreground transition-colors rounded-md p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue/50">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <Dialog.Description className="text-xs text-muted mb-4 flex-shrink-0">
            Suggestions are preloaded from workspace files, version files, package scripts, and compose files. Test the config live before save.
          </Dialog.Description>

          {repoPath && (
            <p className="text-[11px] font-mono text-muted mb-4 truncate flex-shrink-0" title={repoPath}>
              {repoPath}
            </p>
          )}

          <label className="flex items-start gap-2 rounded-md border border-border p-3 text-xs text-muted mb-4 flex-shrink-0">
            <input
              type="checkbox"
              checked={saveInRepo}
              onChange={(e) => setSaveInRepo(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-foreground mb-1">Save into the default branch worktree</span>
              <span>
                Uncheck this to save a global fallback config instead. That fallback is used when the repo path does not have a local `spawntree.yaml`.
              </span>
            </span>
          </label>

          {signals.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4 flex-shrink-0">
              {signals.map((signal, index) => (
                <div
                  key={`${signal.kind}:${signal.label}:${index}`}
                  className={`px-2.5 py-1 rounded-md border text-[11px] ${signalTone(signal.kind)}`}
                  title={signal.detail}
                >
                  <span className="font-medium">{signal.label}</span>
                  <span className="ml-1 opacity-80">{signal.detail}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mb-4 flex-shrink-0">
            <button
              type="button"
              onClick={() => setTab('suggested')}
              className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                tab === 'suggested'
                  ? 'bg-blue/10 border-blue/30 text-blue'
                  : 'border-border text-muted hover:text-foreground hover:border-foreground/30'
              }`}
            >
              Suggested
            </button>
            <button
              type="button"
              onClick={() => setTab('yaml')}
              className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                tab === 'yaml'
                  ? 'bg-blue/10 border-blue/30 text-blue'
                  : 'border-border text-muted hover:text-foreground hover:border-foreground/30'
              }`}
            >
              YAML
            </button>
            {suggestConfig.isPending && (
              <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                <Loader2 className="w-3 h-3 animate-spin" />
                Scanning repo
              </span>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            {tab === 'suggested' ? (
              <div className="space-y-3 pr-1">
                {services.map((service) => (
                  <div key={service.id} className="rounded-lg border border-border bg-background p-4">
                    <div className="flex items-start gap-3 mb-3">
                      <input
                        type="checkbox"
                        checked={service.selected}
                        onChange={(e) => updateService(service.id, { selected: e.target.checked })}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <input
                            value={service.name}
                            onChange={(e) => updateService(service.id, { name: e.target.value })}
                            className="px-2 py-1 rounded-md border border-border bg-surface text-sm text-foreground min-w-[180px]"
                          />
                          <select
                            value={service.type}
                            onChange={(e) => updateService(service.id, { type: e.target.value as ServiceDraft['type'] })}
                            className="px-2 py-1 rounded-md border border-border bg-surface text-xs text-foreground"
                          >
                            <option value="process">process</option>
                            <option value="container">container</option>
                            <option value="postgres">postgres</option>
                            <option value="redis">redis</option>
                          </select>
                          <span className="text-[11px] text-muted">{sourceLabel(service.source)}</span>
                        </div>
                        {service.reason && (
                          <p className="text-[11px] text-muted mb-2 flex items-center gap-1">
                            <Wand2 className="w-3 h-3" />
                            {service.reason}
                          </p>
                        )}

                        {service.type === 'process' && (
                          <input
                            value={service.command ?? ''}
                            onChange={(e) => updateService(service.id, { command: e.target.value })}
                            placeholder="command"
                            className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-xs font-mono text-foreground mb-2"
                          />
                        )}

                        {service.type === 'container' && (
                          <input
                            value={service.image ?? ''}
                            onChange={(e) => updateService(service.id, { image: e.target.value })}
                            placeholder="image"
                            className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-xs font-mono text-foreground mb-2"
                          />
                        )}

                        {(service.type === 'process' || service.type === 'container') && (
                          <div className="grid sm:grid-cols-2 gap-2">
                            <input
                              type="number"
                              value={service.port ?? ''}
                              onChange={(e) =>
                                updateService(service.id, {
                                  port: e.target.value ? Number(e.target.value) : undefined,
                                })
                              }
                              placeholder="port"
                              className="px-2 py-1.5 rounded-md border border-border bg-surface text-xs text-foreground"
                            />
                            <input
                              value={service.dependsOn?.join(', ') ?? ''}
                              onChange={(e) =>
                                updateService(service.id, {
                                  dependsOn: e.target.value
                                    .split(',')
                                    .map((value) => value.trim())
                                    .filter(Boolean),
                                })
                              }
                              placeholder="depends_on (comma separated)"
                              className="px-2 py-1.5 rounded-md border border-border bg-surface text-xs text-foreground"
                            />
                            <input
                              value={service.healthcheckUrl ?? ''}
                              onChange={(e) =>
                                updateService(service.id, {
                                  healthcheckUrl: e.target.value,
                                })
                              }
                              placeholder="healthcheck URL"
                              className="sm:col-span-2 px-2 py-1.5 rounded-md border border-border bg-surface text-xs font-mono text-foreground"
                            />
                          </div>
                        )}

                        {preview && previewEnv.data && (() => {
                          const previewService = previewEnv.data.services.find((item) => item.name === service.name)
                          const previewURL = previewService ? previewURLForService(previewService) : null
                          const testService = testConfig.data?.services?.find((item) => item.name === service.name)
                          if (!previewService && !testService) return null
                          return (
                            <div className="mt-3 rounded-md border border-border bg-surface p-3 space-y-2">
                              <div className="flex items-center gap-2 flex-wrap text-xs">
                                {previewService?.status === 'running' ? (
                                  <span className="inline-flex items-center gap-1 text-green">
                                    <CheckCircle2 className="w-3 h-3" />
                                    Healthcheck passed
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-orange">
                                    <XCircle className="w-3 h-3" />
                                    {previewService?.status ?? 'not started'}
                                  </span>
                                )}
                                {testService && (
                                  <span className={`inline-flex items-center gap-1 ${testService.probeOk ? 'text-green' : 'text-orange'}`}>
                                    {testService.probeOk ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                                    {testService.probeError
                                      ? 'GET / failed'
                                      : testService.probeStatusCode
                                        ? `GET / -> ${testService.probeStatusCode}`
                                        : 'GET / not run'}
                                  </span>
                                )}
                              </div>
                              {previewURL && (
                                <div className="flex items-center gap-3 text-xs">
                                  <a
                                    href={previewURL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-blue hover:underline"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                    Open preview
                                  </a>
                                  <button
                                    type="button"
                                    className="inline-flex items-center gap-1 text-blue hover:underline"
                                    onClick={async () => {
                                      try {
                                        await navigator.clipboard.writeText(previewURL)
                                      } catch {
                                        window.prompt('Copy preview URL', previewURL)
                                      }
                                    }}
                                  >
                                    <Link2 className="w-3 h-3" />
                                    Copy link
                                  </button>
                                </div>
                              )}
                              {testService?.probeBodyPreview && (
                                <pre className="text-[11px] font-mono text-muted bg-background rounded-md p-2 overflow-auto whitespace-pre-wrap">
                                  {testService.probeBodyPreview}
                                </pre>
                              )}
                              <div>
                                <p className="text-[11px] text-muted mb-1">Live logs</p>
                                <LivePreviewLogs
                                  repoID={preview.repoID}
                                  envID={preview.envID}
                                  repoPath={preview.repoPath}
                                  service={service.name}
                                />
                              </div>
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <textarea
                value={rawContent}
                onChange={(e) => {
                  setRawContent(e.target.value)
                  setRawDirty(true)
                  setLastVerifiedContent(null)
                }}
                spellCheck={false}
                className="w-full min-h-[420px] px-3 py-3 text-sm font-mono bg-background border border-border rounded-md text-foreground placeholder:text-muted focus:outline-none focus:border-blue/50 focus:ring-1 focus:ring-blue/30"
              />
            )}
          </div>

          {(testConfig.error || saveConfig.error) && (
            <p className="mt-3 text-xs text-red bg-red/10 border border-red/30 rounded-md px-3 py-2 whitespace-pre-wrap flex-shrink-0">
              {(testConfig.error?.message ?? saveConfig.error?.message) || 'Request failed'}
            </p>
          )}

          {missingHealthchecks.length > 0 && (
            <p className="mt-3 text-xs text-orange bg-orange/10 border border-orange/30 rounded-md px-3 py-2 whitespace-pre-wrap flex-shrink-0">
              Add healthchecks before testing or saving. Missing: {missingHealthchecks.join(', ')}
            </p>
          )}

          {testConfig.data?.ok && lastVerifiedContent === currentContent && (
            <div className="mt-3 flex items-center gap-2 text-xs text-green bg-green/10 border border-green/30 rounded-md px-3 py-2 flex-shrink-0">
              <CheckCircle2 className="w-3 h-3" />
              <span>
                Verified live. Services: {verificationSummary || 'none'}
              </span>
            </div>
          )}

          {testConfig.data?.services?.length && !preview ? (
            <div className="mt-3 rounded-lg border border-border bg-background p-4 space-y-4 flex-shrink-0">
              <h3 className="text-xs font-medium text-muted uppercase tracking-wider">Live Preview</h3>
              {testConfig.data.services.map((service) => (
                <div key={service.name} className="rounded-md border border-border bg-surface p-3">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="font-semibold text-sm text-foreground">{service.name}</span>
                    <span className="text-[11px] text-muted">{service.type}</span>
                    <span className={`text-[11px] ${service.probeOk ? 'text-green' : 'text-orange'}`}>
                      {service.probeError
                        ? `GET / failed`
                        : service.probeStatusCode
                          ? `GET / -> ${service.probeStatusCode}`
                          : 'No probe'}
                    </span>
                  </div>
                  {service.previewUrl && (
                    <div className="flex items-center gap-3 text-xs mb-2">
                      <a
                        href={service.previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue hover:underline"
                      >
                        Open preview
                      </a>
                      <button
                        type="button"
                        className="text-blue hover:underline"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(service.previewUrl!)
                          } catch {
                            window.prompt('Copy preview URL', service.previewUrl)
                          }
                        }}
                      >
                        Copy link
                      </button>
                    </div>
                  )}
                  {service.probeBodyPreview && (
                    <pre className="text-[11px] font-mono text-muted bg-background rounded-md p-2 overflow-auto mb-2 whitespace-pre-wrap">
                      {service.probeBodyPreview}
                    </pre>
                  )}
                  {service.probeError && (
                    <p className="text-[11px] text-orange mb-2">{service.probeError}</p>
                  )}
                  <div>
                    <p className="text-[11px] text-muted mb-1">Recent logs</p>
                    <pre className="text-[11px] font-mono text-foreground bg-background rounded-md p-2 overflow-auto max-h-40 whitespace-pre-wrap">
                      {service.logs.length > 0 ? service.logs.join('\n') : 'No logs yet'}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-4 flex-shrink-0">
            <button
              type="button"
              onClick={handleTest}
              disabled={!repoPath || testConfig.isPending || saveConfig.isPending || missingHealthchecks.length > 0}
              className="flex items-center gap-2 px-4 py-2 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50 min-h-[36px]"
            >
              {testConfig.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              {testConfig.isPending ? 'Testing…' : 'Test Config'}
            </button>
            <button
              type="button"
              onClick={preview ? handleStopPreview : handlePreview}
              disabled={!repoPath || startPreview.isPending || stopPreview.isPending || saveConfig.isPending || missingHealthchecks.length > 0}
              className="flex items-center gap-2 px-4 py-2 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50 min-h-[36px]"
            >
              {(startPreview.isPending || stopPreview.isPending) && <Loader2 className="w-3 h-3 animate-spin" />}
              {preview ? (
                <>
                  <Square className="w-3 h-3" />
                  Stop Preview
                </>
              ) : startPreview.isPending ? (
                'Starting Preview…'
              ) : (
                'Run Preview'
              )}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="flex items-center gap-2 px-4 py-2 text-xs rounded-md bg-blue text-background font-medium hover:bg-blue/90 transition-colors disabled:opacity-50 min-h-[36px]"
            >
              {saveConfig.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              {saveConfig.isPending ? 'Saving…' : 'Save Config'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
