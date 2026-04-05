import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, Loader2, Settings2, X } from 'lucide-react'
import { useSaveConfig, useTestConfig } from '../lib/api'

interface AddConfigDialogProps {
  open: boolean
  repoPath: string | null
  onOpenChange: (open: boolean) => void
}

function starterConfig() {
  return `services:
  app:
    type: process
    command: npm run dev
    port: 3000
`
}

export function AddConfigDialog({ open, repoPath, onOpenChange }: AddConfigDialogProps) {
  const [content, setContent] = useState(starterConfig())
  const [saveInRepo, setSaveInRepo] = useState(true)
  const [lastVerifiedContent, setLastVerifiedContent] = useState<string | null>(null)

  const testConfig = useTestConfig()
  const saveConfig = useSaveConfig()

  useEffect(() => {
    if (!open) return
    setContent(starterConfig())
    setSaveInRepo(true)
    setLastVerifiedContent(null)
  }, [open, repoPath])

  const verificationSummary = useMemo(() => {
    if (!testConfig.data?.ok) return null
    return testConfig.data.serviceNames.join(', ')
  }, [testConfig.data])

  const canSave = !!repoPath && lastVerifiedContent === content && !!testConfig.data?.ok && !saveConfig.isPending

  async function handleTest() {
    if (!repoPath) return
    const result = await testConfig.mutateAsync({ repoPath, content })
    if (result.ok) {
      setLastVerifiedContent(content)
    }
  }

  async function handleSave() {
    if (!repoPath || !canSave) return
    await saveConfig.mutateAsync({
      repoPath,
      content,
      saveMode: saveInRepo ? 'repo' : 'global',
    })
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(92vw,860px)] bg-surface border border-border rounded-xl shadow-2xl p-6 focus:outline-none">
          <div className="flex items-center justify-between mb-5">
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

          <Dialog.Description className="text-xs text-muted mb-4">
            Test the config against this repo before saving. Saving stays disabled until the live test passes.
          </Dialog.Description>

          {repoPath && (
            <p className="text-[11px] font-mono text-muted mb-4 truncate" title={repoPath}>
              {repoPath}
            </p>
          )}

          <label className="flex items-start gap-2 rounded-md border border-border p-3 text-xs text-muted mb-4">
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

          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
            }}
            spellCheck={false}
            className="w-full min-h-[320px] px-3 py-3 text-sm font-mono bg-background border border-border rounded-md text-foreground placeholder:text-muted focus:outline-none focus:border-blue/50 focus:ring-1 focus:ring-blue/30"
          />

          {(testConfig.error || saveConfig.error) && (
            <p className="mt-3 text-xs text-red bg-red/10 border border-red/30 rounded-md px-3 py-2 whitespace-pre-wrap">
              {(testConfig.error?.message ?? saveConfig.error?.message) || 'Request failed'}
            </p>
          )}

          {testConfig.data?.ok && lastVerifiedContent === content && (
            <div className="mt-3 flex items-center gap-2 text-xs text-green bg-green/10 border border-green/30 rounded-md px-3 py-2">
              <CheckCircle2 className="w-3 h-3" />
              <span>
                Verified live. Services: {verificationSummary || 'none'}
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <button
              type="button"
              onClick={handleTest}
              disabled={!repoPath || testConfig.isPending || saveConfig.isPending}
              className="flex items-center gap-2 px-4 py-2 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50 min-h-[36px]"
            >
              {testConfig.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              {testConfig.isPending ? 'Testing…' : 'Test Config'}
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
