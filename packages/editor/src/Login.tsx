import { useState } from 'preact/hooks'
import { api, ApiError } from './api.ts'

/** Without `onClose` there is nothing to go back to: the prompt stays until the code is given. */
export function Login({ onSuccess, onClose }: { onSuccess: () => void; onClose?: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy || !code.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.login(code)
      onSuccess()
    } catch (err) {
      const reason = err instanceof ApiError ? err.code : ''
      setError(
        reason === 'bad_code'
          ? 'Ce code n’est pas le bon. Vérifiez-le et réessayez.'
          : reason === 'too_many'
            ? 'Trop d’essais. Patientez cinq minutes avant de réessayer.'
            : 'Impossible de joindre le site. Vérifiez votre connexion ; si elle fonctionne, l’ordinateur de votre développeur est peut-être éteint.',
      )
      setBusy(false)
    }
  }

  return (
    <>
      <div class="scrim" />
      <div class="panel is-centered is-narrow" role="dialog" aria-label="Modifier ce site">
        <header class="panel-head">
          <div>
            <h2 class="panel-title">Modifier ce site</h2>
            <p class="panel-context">Saisissez le code d’accès donné par votre développeur.</p>
          </div>
          {onClose && <button type="button" class="close" aria-label="Fermer" onClick={onClose} />}
        </header>
        <form
          class="panel-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div class="panel-body">
            <label class="label" for="foliome-code">
              Code d’accès
            </label>
            <input
              id="foliome-code"
              class="input is-code"
              type="text"
              value={code}
              placeholder="ABCD-EFGH"
              autoFocus
              autocomplete="off"
              autocapitalize="characters"
              spellcheck={false}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </div>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <footer class="panel-foot">
            <button type="submit" class="btn is-primary" disabled={busy || !code.trim()}>
              Entrer
            </button>
          </footer>
        </form>
      </div>
    </>
  )
}
