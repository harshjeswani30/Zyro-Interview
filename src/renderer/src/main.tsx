import './assets/main.css'

import { createRoot } from 'react-dom/client'
import App from './App'

// A throw here (a bad import, a missing build-time env var, a failed chunk) used to
// propagate before React mounted, leaving the window on its opaque black backgroundColor
// with nothing on screen and no clue why. Catch it and paint a visible, dark surface with
// the actual error instead of a silent black screen.
function mount(): void {
  const root = document.getElementById('root')
  if (!root) return
  try {
    createRoot(root).render(<App />)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Renderer] mount failed:', err)
    root.innerHTML = `
      <div style="width:100vw;height:100vh;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:12px;background:#0a0a14;color:#e7e7ea;
        font-family:'Inter',system-ui,sans-serif;text-align:center;padding:24px;-webkit-app-region:drag">
        <div style="font-size:15px;font-weight:600">Something went wrong starting the app</div>
        <div style="font-size:12px;opacity:.7;max-width:520px;word-break:break-word">${msg}</div>
      </div>`
  }
}

mount()
