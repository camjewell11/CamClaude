import { createRoot } from 'react-dom/client'

import { App } from './App'
import { createRemoteApi } from './remoteApi'
import './styles.css'

// In the desktop window the preload provides window.cam; in a phone's browser, connect to the PC.
if (!window.cam) window.cam = createRemoteApi()
document.documentElement.classList.toggle('remote', window.cam.isRemote)
// The CamClaude app on another PC: a desktop window with native window buttons, not a browser.
document.documentElement.classList.toggle('client', !!window.camClient)

createRoot(document.getElementById('root')!).render(<App />)
