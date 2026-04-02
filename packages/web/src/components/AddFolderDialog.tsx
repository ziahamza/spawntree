import { useState, useRef, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, Loader2, FolderPlus } from 'lucide-react'
import { useAddFolder } from '../lib/api'

interface AddFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Step = 'idle' | 'detecting' | 'pickRemote' | 'error'

interface RemoteOption {
  name: string
  url: string
}

const ERROR_MESSAGES: Record<string, string> = {
  'not a git repository': 'Not a Git repository',
  'no such file': 'Path not found',
  'path not found': 'Path not found',
  'does not exist': 'Path not found',
}

function friendlyError(raw: string): string {
  const lower = raw.toLowerCase()
  for (const [key, msg] of Object.entries(ERROR_MESSAGES)) {
    if (lower.includes(key)) return msg
  }
  return raw
}

export function AddFolderDialog({ open, onOpenChange }: AddFolderDialogProps) {
  const [path, setPath] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  const [remotes, setRemotes] = useState<RemoteOption[]>([])
  const [selectedRemote, setSelectedRemote] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  const addFolder = useAddFolder()

  useEffect(() => {
    if (open) {
      setPath('')
      setStep('idle')
      setError(null)
      setRemotes([])
      setSelectedRemote('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!path.trim()) return

    setStep('detecting')
    setError(null)

    try {
      await addFolder.mutateAsync({
        path: path.trim(),
        remoteName: step === 'pickRemote' ? selectedRemote : undefined,
      })
      onOpenChange(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(friendlyError(msg))
      setStep('error')
    }
  }

  const isLoading = step === 'detecting'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-surface border border-border rounded-xl shadow-2xl p-6 focus:outline-none"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <FolderPlus className="w-4 h-4 text-blue" />
              <Dialog.Title className="font-display font-semibold text-sm text-foreground">
                Add folder
              </Dialog.Title>
            </div>
            <Dialog.Close className="text-muted hover:text-foreground transition-colors rounded-md p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue/50">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <Dialog.Description className="text-xs text-muted mb-4">
            Enter the path to a Git repository folder to link it to spawntree.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Path input */}
            <div>
              <label className="block text-xs text-muted mb-1.5" htmlFor="folder-path">
                Folder path
              </label>
              <input
                ref={inputRef}
                id="folder-path"
                type="text"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value)
                  setError(null)
                  setStep('idle')
                }}
                placeholder="/Users/you/projects/my-app"
                disabled={isLoading}
                className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-md text-foreground placeholder:text-muted focus:outline-none focus:border-blue/50 focus:ring-1 focus:ring-blue/30 disabled:opacity-50"
              />
            </div>

            {/* Remote picker */}
            {step === 'pickRemote' && remotes.length > 0 && (
              <div>
                <label className="block text-xs text-muted mb-1.5" htmlFor="remote-select">
                  Multiple remotes found — pick one
                </label>
                <select
                  id="remote-select"
                  value={selectedRemote}
                  onChange={(e) => setSelectedRemote(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-md text-foreground focus:outline-none focus:border-blue/50"
                >
                  {remotes.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name} — {r.url}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Error message */}
            {error && (
              <p className="text-xs text-red bg-red/10 border border-red/30 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close
                type="button"
                className="px-4 py-2 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30 transition-colors min-h-[36px]"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!path.trim() || isLoading}
                className="flex items-center gap-2 px-4 py-2 text-xs rounded-md bg-blue text-background font-medium hover:bg-blue/90 transition-colors disabled:opacity-50 min-h-[36px]"
              >
                {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                {isLoading ? 'Detecting…' : 'Add folder'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
