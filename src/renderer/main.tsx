import { createRoot } from 'react-dom/client'

import { App } from './App'
import { createRemoteApi } from './remoteApi'
import './styles.css'

// In the desktop window the preload provides window.cam; in a phone's browser, connect to the PC.
if (!window.cam) window.cam = createRemoteApi()
document.documentElement.classList.toggle('remote', window.cam.isRemote)

createRoot(document.getElementById('root')!).render(<App />)
