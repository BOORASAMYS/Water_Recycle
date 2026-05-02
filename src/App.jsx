import { useEffect, useState } from 'react'
import WaterSystem from './components/WaterSystem'
import HouseGrid from './components/HouseGrid'
import { useWaterSystem } from './hooks/useWaterSystem'
import cyberLancers_Logo from './assets/CyberLancers_Logo.svg'
import cdacLogo from './assets/cdac-logo.svg'

import './App.css'

const SPLASH_MESSAGES = [
  'Initializing sensors...',
  'Connecting water modules...',
  'Verifying automation...',
  'Preparing dashboard...',
]

export default function App() {
  const [showSplash, setShowSplash] = useState(true)
  const [messageIndex, setMessageIndex] = useState(0)
  const system = useWaterSystem()
  const {
    houses,
    toggleConsumption,
    rechargeWallet,
    apiAttack,
    mainTankLevel,
    resetSystem,
    triggerDrain,
  } = system

  const house1 = houses[0]
  const restHouses = houses.slice(1)

  useEffect(() => {
    const splashTimer = window.setTimeout(() => {
      setShowSplash(false)
    }, 10000)

    const messageTimer = window.setInterval(() => {
      setMessageIndex((current) => (current + 1) % SPLASH_MESSAGES.length)
    }, 2400)

    return () => {
      window.clearTimeout(splashTimer)
      window.clearInterval(messageTimer)
    }
  }, [])

  useEffect(() => {
    const enterFullscreen = () => {
      const root = document.documentElement
      const requestFullscreen =
        root.requestFullscreen ||
        root.webkitRequestFullscreen ||
        root.msRequestFullscreen

      if (!document.fullscreenElement && requestFullscreen) {
        Promise.resolve(requestFullscreen.call(root)).catch(() => {})
      }
    }

    window.addEventListener('click', enterFullscreen, { once: true })

    return () => {
      window.removeEventListener('click', enterFullscreen)
    }
  }, [])

  return (
    <div className="app">
      {showSplash && (
        <div className="splash-screen" role="status" aria-live="polite">
          <div className="splash-orb splash-orb-a" />
          <div className="splash-orb splash-orb-b" />
          <div className="splash-card">
            <div className="splash-logos">
              <div className="splash-logo splash-logo-cyber">
                <img src={cyberLancers_Logo} alt="Cyber Lancers" />
              </div>
              <div className="splash-logo-divider" />
              <div className="splash-logo splash-logo-cdac">
                <img src={cdacLogo} alt="CDAC" />
              </div>
            </div>

            <h2 className="splash-title">SMART AGRICULTURE MODEL</h2>

            <div className="splash-progress-track" aria-hidden="true">
              <div className="splash-progress-fill" />
            </div>

            <p className="splash-message">{SPLASH_MESSAGES[messageIndex]}</p>
          </div>
        </div>
      )}

      <header className="app-header">
        <div className="header-brand">
          <h1>Water Management</h1>
        </div>

        <div className="header-controls">
          <button className="nav-btn nav-btn-reset" onClick={resetSystem}>
            Reset System
          </button>

          <button className="nav-btn nav-btn-drain" onClick={triggerDrain}>
            Drain
          </button>

          <div className="nav-logo-group" aria-label="Navbar logos">
            <div className="nav-logo-badge" aria-label="CyberLancers logo">
              <img src={cyberLancers_Logo} alt="CyberLancers" />
            </div>
            <div className="nav-logo-badge" aria-label="CDAC logo">
              <img src={cdacLogo} alt="CDAC" />
            </div>
          </div>

          <button className="nav-power-btn" type="button" aria-label="System power">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3v8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              <path
                d="M7.8 5.8a8 8 0 1 0 8.4 0"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <main className="app-main">
        <div className="top-section">
          <div className="pipeline-section">
            <WaterSystem system={system} />
          </div>
          <div className="house1-wrapper">
            <HouseGrid
              system={system}
              houses={[house1]}
              onToggle={toggleConsumption}
              onRecharge={rechargeWallet}
              apiAttack={apiAttack}
              mainTankLevel={mainTankLevel}
              singleColumn
            />
          </div>
        </div>

          <div className="bottom-section">
          <HouseGrid
            system={system}
            houses={restHouses}
            onToggle={toggleConsumption}
            onRecharge={rechargeWallet}
            apiAttack={apiAttack}
            mainTankLevel={mainTankLevel}
          />
        </div>
      </main>
    </div>
  )
}
