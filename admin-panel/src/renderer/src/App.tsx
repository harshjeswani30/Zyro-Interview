import { useState } from 'react'
import LoginPage from './components/LoginPage'
import CouponsPage from './components/CouponsPage'

export default function App() {
  const [authed, setAuthed] = useState(false)

  if (!authed) {
    return <LoginPage onLogin={() => setAuthed(true)} />
  }

  return <CouponsPage />
}
