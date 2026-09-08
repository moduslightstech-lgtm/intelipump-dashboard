import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  deleteAdminTank,
  fmtLiters,
  getTankDeletionPreview,
  humanizeEnum,
  type TankDeletionPreview,
} from '../../api/client'
import ConfirmDialog from '../ConfirmDialog'

type TankSummary = {
  id: string
  tankCode: string
  name: string
  product: string
  capacityLiters: number | null
  status: string
}

type Props = {
  open: boolean
  stationId: string
  stationName?: string
  tank: TankSummary | null
  onClose: () => void
  onDeleted: (result: { mode: string; tankCode: string; archived: boolean }) => void
}

export default function DeleteTankModal({ open, stationId, stationName, tank, onClose, onDeleted }: Props) {
  const [preview, setPreview] = useState<TankDeletionPreview | null>(null)
  const [loadError, setLoadError] = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [inlineError, setInlineError] = useState('')

  useEffect(() => {
    if (!open || !tank) {
      setPreview(null)
      setConfirmCode('')
      setInlineError('')
      setLoadError('')
      return
    }
    let cancelled = false
    setLoadError('')
    getTankDeletionPreview(stationId, tank.id)
      .then((r) => {
        if (!cancelled) setPreview(r.data)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not inspect tank dependencies.')
      })
    return () => {
      cancelled = true
    }
  }, [open, stationId, tank])

  const mut = useMutation({
    mutationFn: async () => {
      if (!tank) throw new Error('No tank')
      return (
        await deleteAdminTank(stationId, tank.id, {
          confirmDisconnect: preview?.requiresDisconnect,
          confirmCode: preview?.requiresCodeConfirm ? confirmCode : undefined,
        })
      ).data
    },
    onSuccess: (data) => {
      onDeleted({ mode: data.mode, tankCode: data.tankCode, archived: data.archived })
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail
      if (detail && typeof detail === 'object') {
        setInlineError(detail.message || 'Deletion was not completed.')
        if (detail.preview) setPreview(detail.preview)
        return
      }
      setInlineError(typeof detail === 'string' ? detail : 'Deletion was not completed.')
    },
  })

  const codeOk = !preview?.requiresCodeConfirm || confirmCode.trim().toUpperCase() === (preview?.tankCode || tank?.tankCode || '').toUpperCase()
  const confirmLabel =
    preview?.mode === 'DISCONNECT_AND_DELETE'
      ? 'Disconnect and delete'
      : preview?.mode === 'ARCHIVE'
        ? 'Archive tank'
        : 'Delete tank'

  return (
    <ConfirmDialog
      open={open}
      title="Delete tank?"
      onClose={() => {
        if (!mut.isPending) onClose()
      }}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={mut.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-secondary bg-rose-800 hover:bg-rose-700 text-white"
            disabled={mut.isPending || !preview || !codeOk}
            onClick={() => {
              setInlineError('')
              mut.mutate()
            }}
          >
            {mut.isPending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {loadError && (
        <p className="text-sm text-red-300" role="alert">
          {loadError}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">Name</dt>
        <dd className="text-slate-200">{preview?.name || tank?.name || '—'}</dd>
        <dt className="text-slate-500">Code</dt>
        <dd className="font-mono text-slate-200">{preview?.tankCode || tank?.tankCode}</dd>
        <dt className="text-slate-500">Product</dt>
        <dd>{preview?.product || tank?.product || '—'}</dd>
        <dt className="text-slate-500">Capacity</dt>
        <dd>{fmtLiters(preview?.capacityLiters ?? tank?.capacityLiters)}</dd>
        <dt className="text-slate-500">Status</dt>
        <dd>{humanizeEnum(preview?.status || tank?.status)}</dd>
        <dt className="text-slate-500">Station</dt>
        <dd>{preview?.stationName || stationName || '—'}</dd>
      </dl>
      {preview && (
        <p className="text-sm text-slate-300">{preview.explanation}</p>
      )}
      {preview?.connections.length ? (
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
          <div className="text-slate-400 text-xs uppercase tracking-wide mb-1">Connected pumps</div>
          <ul className="space-y-1">
            {preview.connections.map((c) => (
              <li key={c.id} className="text-slate-200">
                {c.pumpName || c.pumpCode}
                <span className="text-slate-500"> · {c.active ? 'Active' : 'Inactive'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview?.requiresCodeConfirm && (
        <label className="block text-sm">
          <span className="label-text">Type {preview.tankCode} to confirm</span>
          <input
            className="input mt-1 font-mono"
            value={confirmCode}
            onChange={(e) => setConfirmCode(e.target.value)}
            aria-required="true"
          />
        </label>
      )}
      {inlineError && (
        <p className="text-sm text-red-300" role="alert">
          {inlineError}
        </p>
      )}
    </ConfirmDialog>
  )
}
