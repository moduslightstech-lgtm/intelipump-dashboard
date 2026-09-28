import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'

type FieldProps = {
  label: string
  htmlFor?: string
  error?: string | null
  className?: string
  children: ReactNode
}

export function CompactField({ label, htmlFor, error, className = '', children }: FieldProps) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="mt-0.5 block text-[11px] text-red-300" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  error?: string | null
}

export function CompactInput({ label, error, className = '', id, ...rest }: InputProps) {
  const autoId = useId()
  const inputId = id || rest.name || autoId
  return (
    <CompactField label={label} htmlFor={inputId} error={error}>
      <input id={inputId} className={`input-compact ${className}`} {...rest} />
    </CompactField>
  )
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
  error?: string | null
}

export function CompactSelect({ label, error, className = '', id, children, ...rest }: SelectProps) {
  const autoId = useId()
  const inputId = id || rest.name || autoId
  return (
    <CompactField label={label} htmlFor={inputId} error={error}>
      <select id={inputId} className={`input-compact ${className}`} {...rest}>
        {children}
      </select>
    </CompactField>
  )
}
