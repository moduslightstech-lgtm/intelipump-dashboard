import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

type FieldProps = {
  label: string
  htmlFor?: string
  error?: string | null
  className?: string
  children: ReactNode
}

export function CompactField({ label, htmlFor, error, className = '', children }: FieldProps) {
  return (
    <label className={`block min-w-0 ${className}`} htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {error ? (
        <span className="mt-0.5 block text-[11px] text-red-300" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  )
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  error?: string | null
}

export function CompactInput({ label, error, className = '', id, ...rest }: InputProps) {
  const inputId = id || rest.name || undefined
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
  const inputId = id || rest.name || undefined
  return (
    <CompactField label={label} htmlFor={inputId} error={error}>
      <select id={inputId} className={`input-compact ${className}`} {...rest}>
        {children}
      </select>
    </CompactField>
  )
}
