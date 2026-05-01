import WaterSystem from './components/WaterSystem'
import HouseGrid from './components/HouseGrid'
import { useWaterSystem } from './hooks/useWaterSystem'
import cyberLancers_Logo from './assets/CyberLancers_Logo.svg'
import cdacLogo from './assets/cdac-logo.svg'

import './App.css'

export default function App() {
  const system = useWaterSystem()
  const {
    houses,
    toggleConsumption,
    rechargeWallet,
    apiAttack,
    mainTankLevel,
    resetSystem,
  } = system

  const house1 = houses[0]
  const restHouses = houses.slice(1)

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-brand">
          <h1>Water Management</h1>
        </div>

        <div className="header-controls">
          <button className="nav-btn nav-btn-reset" onClick={resetSystem}>
            Reset System
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
