import { useState } from 'react'
import './HouseGrid.css'

const HOUSE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6']

function HouseCard({ house, onToggle, onRecharge, apiAttack, mainTankLevel, pilferageActive, onPilferageToggle }) {
  const [rechargeAmt, setRechargeAmt] = useState(50)
  const color = HOUSE_COLORS[house.id - 1]
  const walletPct = house.wallet
  const isLowWallet = house.wallet < 20
  const canConsume = house.wallet > 0 && mainTankLevel > 5
  const led = house.consuming && canConsume ? 'green' : 'red'
  const showPilferageButton = house.id === 1
  const noBalance = house.wallet <= 0
  const isTapDisabled = house.id === 1
    ? pilferageActive || (!canConsume && !house.consuming)
    : !canConsume && !house.consuming

  return (
    <div className={`house-card ${house.id === 1 ? 'house-1' : ''} ${apiAttack ? 'house-attack' : ''} ${pilferageActive ? 'pilferage-active' : ''}`} style={{ '--house-color': color }}>
      <div className="house-icon-area">
        <svg width="120" height="106" viewBox="0 0 56 50" fill="none" className={`house-svg ${house.consuming && canConsume ? 'house-active' : ''}`}>
          <polygon points="28,2 52,20 4,20" fill={color} opacity="0.9" />
          <polygon points="28,2 52,20 4,20" fill="none" stroke={color} strokeWidth="1.5" />
          <rect x="8" y="20" width="40" height="28" fill="#f8fafc" stroke="#e2e8f0" strokeWidth="1.5" />
          <rect x="22" y="32" width="12" height="16" rx="6" fill={color} opacity="0.7" />
          <rect x="11" y="24" width="10" height="8" rx="2" fill={color} opacity="0.3" stroke={color} strokeWidth="1" />
          <rect x="35" y="24" width="10" height="8" rx="2" fill={color} opacity="0.3" stroke={color} strokeWidth="1" />
          <rect x="36" y="6" width="6" height="10" fill="#94a3b8" />
          {house.consuming && canConsume && (
            <>
              <circle cx="39" cy="4" r="2" fill="#cbd5e1" opacity="0.6" className="smoke s1" />
              <circle cx="41" cy="1" r="1.5" fill="#cbd5e1" opacity="0.4" className="smoke s2" />
            </>
          )}
        </svg>
        <div className={`led-indicator led-${led}`} title={led === 'green' ? 'Consuming water' : 'Not consuming'} />
      </div>

      <div className="house-info">
        <div className="house-name">{house.name}</div>
      </div>

      <div className="wallet-section">
        <div className="wallet-header">
          <span className="wallet-label">Wallet</span>
          <span className={`wallet-amount ${isLowWallet ? 'wallet-low' : ''}`}>
            ₹{house.wallet.toFixed(1)}
          </span>
        </div>
        <div className="wallet-bar-bg">
          <div
            className="wallet-bar-fill"
            style={{ width: `${walletPct}%`, background: isLowWallet ? '#ef4444' : color }}
          />
        </div>
        <div className="wallet-meta">
          <span>{(house.waterLevel ?? 0).toFixed(1)} L water</span>
          <span>₹5/L</span>
        </div>
      </div>

      <div className="house-controls">
        {showPilferageButton && (
          <button
            type="button"
            className={`pilferage-alert ${pilferageActive ? 'pilferage-active' : ''}`}
            onClick={onPilferageToggle}
            aria-pressed={pilferageActive}
          >
            ⚠️ Pilferage {pilferageActive ? 'ON' : 'OFF'}
          </button>
        )}
        <button
          className={`tap-btn ${house.consuming && canConsume ? 'tap-on' : 'tap-off'}${noBalance && !house.consuming ? ' tap-no-balance' : ''}`}
          onClick={() => onToggle(house.id)}
          disabled={isTapDisabled}
          style={{ '--c': color }}
          title={noBalance && !house.consuming ? 'No balance — recharge to open tap' : undefined}
        >
          <TapIcon active={house.consuming && canConsume} />
          {house.consuming && canConsume ? 'Close Tap' : noBalance ? 'No Balance' : 'Open Tap'}
        </button>
        <div className="recharge-row">
          <select
            className="recharge-input"
            value={rechargeAmt}
            onChange={e => setRechargeAmt(Number(e.target.value))}
          >
            <option value={10}>₹10</option>
            <option value={25}>₹25</option>
            <option value={50}>₹50</option>
            <option value={100}>₹100</option>
          </select>
          <button
            className="recharge-btn"
            style={{ '--c': color }}
            onClick={() => onRecharge(house.id, rechargeAmt)}
            disabled={house.wallet >= 100}
          >
            + Recharge
          </button>
        </div>
      </div>
    </div>
  )
}

function TapIcon({ active }) {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none">
      <path d="M2 4h8a2 2 0 012 2v1H2V4z" fill="currentColor" opacity="0.8" />
      <path d="M5 7v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {active && <path d="M5 12l-1 2M5 12l1 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  )
}

export default function HouseGrid({ system, houses: housesProp, onToggle, onRecharge, apiAttack: apiAttackProp, mainTankLevel: mainTankLevelProp, singleColumn = false }) {
  const houses = housesProp ?? system.houses
  const toggleConsumption = onToggle ?? system.toggleConsumption
  const rechargeWallet = onRecharge ?? system.rechargeWallet
  const apiAttack = apiAttackProp ?? system.apiAttack
  const mainTankLevel = mainTankLevelProp ?? system.mainTankLevel
  const pilferageActive = system.pilferageActive
  const setPilferageActive = system.setPilferageActive

  return (
    <div className={`house-grid-wrapper ${singleColumn ? 'house-grid-single' : ''}`}>
      <div className={`house-grid ${singleColumn ? 'house-grid-1col' : ''}`} style={!singleColumn ? { gridTemplateColumns: `repeat(${houses.length}, 1fr)` } : undefined}>
        {houses.map(house => (
          <HouseCard
            key={house.id}
            house={house}
            onToggle={toggleConsumption}
            onRecharge={rechargeWallet}
            apiAttack={apiAttack}
            mainTankLevel={mainTankLevel}
            pilferageActive={house.id === 1 ? pilferageActive : false}
            onPilferageToggle={() => setPilferageActive(current => !current)}
          />
        ))}
      </div>
    </div>
  )
}
