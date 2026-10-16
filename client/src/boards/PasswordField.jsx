import { useId, useState } from 'react';
import { ErrorIcon, EyeIcon } from '../chrome/icons.jsx';

// A password input with a show/hide button inside it (design/v1 Lock-Screen, Landing-States 3). Never pre-filled,
// never stored: the value lives only in the form that owns it.
export function PasswordField({
  label,
  optional = false,
  value,
  onChange,
  error,
  hint,
  disabled = false,
  busy = false,
  placeholder,
  autoFocus = false,
  autoComplete = 'current-password',
  inputRef,
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const described = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label} {optional && <span className="field-label-quiet">(optional)</span>}
      </label>
      <span className={`field-box${error ? ' is-error' : ''}${busy ? ' is-busy' : ''}`}>
        <input
          id={id}
          ref={inputRef}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={described}
        />
        <button
          type="button"
          className="icon-btn icon-btn-dot"
          onClick={() => setShown((s) => !s)}
          disabled={disabled}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          title={shown ? 'Hide password' : 'Show password'}
        >
          <EyeIcon off={shown} />
        </button>
      </span>
      {error && (
        <span id={`${id}-err`} className="field-error" role="alert">
          <ErrorIcon />
          {error}
        </span>
      )}
      {hint && (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
