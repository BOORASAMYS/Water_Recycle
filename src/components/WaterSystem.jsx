import './WaterSystem.css'

function PipeSegment({ flowing = false, attack = false }) {
  return (
    <div className="wm-segment" aria-hidden="true">
      <div className="wm-segment-base" />
      <div className={`wm-segment-flow ${flowing ? 'is-flowing' : ''} ${attack ? 'is-attack' : ''}`} />
    </div>
  )
}

function SideTank({ title, level, maxLevel, side, low = false, showScale = true, valueLabel = null, onClick = null, active = false, badge = null, disabled = false }) {
  const pct = Math.max(0, Math.min(100, (level / maxLevel) * 100))
  const clickable = !!onClick && !disabled

  return (
    <div
      className={`wm-tank-card wm-tank-card-${side} ${clickable ? 'is-clickable' : ''} ${active ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      title={clickable ? 'Click to toggle pump' : undefined}
    >
      <div className="wm-tank-shell">
        <div className="wm-tank-lid" />
        <div className="wm-tank-body">
          <div className="wm-tank-water" style={{ height: `${pct}%` }} />
          {valueLabel && <div className="wm-tank-value">{valueLabel}</div>}
        </div>
        {showScale && (
          <div className={`wm-scale wm-scale-${side}`}>
            {[100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0].map(mark => (
              <span key={mark}>{mark}</span>
            ))}
          </div>
        )}
      </div>
      <div className="wm-card-title wm-card-title-bottom">
        {title}
        {low && <span className="wm-low-pill">LOW</span>}
        {badge && <span className={`wm-state-pill ${active ? 'on' : 'off'}`}>{badge}</span>}
      </div>
    </div>
  )
}

function Pump({ label, active, attack = false, onClick, disabled = false }) {
  const clickable = !!onClick && !disabled

  return (
    <div
      className={`wm-pump-block ${clickable ? 'is-clickable' : ''} ${disabled ? 'is-disabled' : ''}`}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick && onClick() } } : undefined}
      title={clickable ? `Click to turn ${label} ${active ? 'OFF' : 'ON'}` : undefined}
    >
      <div className={`wm-pump ${active ? 'is-active' : ''} ${attack ? 'is-attack' : ''}`}>
        <div className="wm-pump-ring" />
        <div className="wm-pump-housing">
          <div className={`wm-pump-fan ${active ? 'is-spinning' : ''}`}>
            <span className="wm-pump-blade blade-a" />
            <span className="wm-pump-blade blade-b" />
            <span className="wm-pump-blade blade-c" />
            <span className="wm-pump-blade blade-d" />
          </div>
          <div className="wm-pump-center" />
        </div>
        <div className="wm-pump-port wm-pump-port-left" />
        <div className="wm-pump-port wm-pump-port-right" />
      </div>
      <div className="wm-pump-label wm-pump-label-bottom">
        {label}
        <span className={`wm-state-pill ${active ? 'on' : 'off'}`}>{active ? 'ON' : 'OFF'}</span>
      </div>
    </div>
  )
}

function PurificationTank({ active, onClick, disabled = false }) {
  const clickable = !!onClick && !disabled

  return (
    <div
      className={`wm-purification-card ${clickable ? 'is-clickable' : ''} ${active ? 'is-on' : 'is-off'} ${disabled ? 'is-disabled' : ''}`}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick && onClick() } } : undefined}
      title={clickable ? `Click to turn purification ${active ? 'OFF' : 'ON'}` : undefined}
    >
      <div className="wm-purification-tank">
        <div className={`wm-purification-water ${active ? 'is-active' : ''}`} aria-hidden="true">
          <span className="wm-purification-blob wm-purification-blob-a" />
          <span className="wm-purification-blob wm-purification-blob-b" />
          <span className="wm-purification-blob wm-purification-blob-c" />
          <span className="wm-purification-blob wm-purification-blob-d" />
          <span className="wm-purification-mist wm-purification-mist-a" />
          <span className="wm-purification-mist wm-purification-mist-b" />
          <span className="wm-purification-glow" />
        </div>
        <div className={`wm-stirrer ${active ? 'is-spinning' : ''}`}>
          <span className="wm-stirrer-stick" />
        </div>
      </div>
      <div className="wm-purification-label">
        Purification
        <span className={`wm-state-pill ${active ? 'on' : 'off'}`}>{active ? 'ON' : 'OFF'}</span>
      </div>
    </div>
  )
}

export default function WaterSystem({ system }) {
  const {
    purificationLevel,
    mainTankLevel,
    isUiFrozen,
    purificationActive, setPurificationActive,
    pumpR2P, setPumpR2P,
    pumpP2M, setPumpP2M,
    modbusAttack,
    PURIFICATION_CAPACITY,
    MAIN_TANK_CAPACITY,
  } = system

  const mainLow = (mainTankLevel / MAIN_TANK_CAPACITY) * 100 <= 20

  return (
    <div className="water-system water-management-diagram">
      <div className="wm-diagram">
        <div className="wm-flow-layout">
          <SideTank
            title="Reservoir"
            level={PURIFICATION_CAPACITY}
            maxLevel={PURIFICATION_CAPACITY}
            side="left"
            showScale={false}
          />
          <PipeSegment flowing={pumpR2P} />
          <Pump label="Pump 1" active={pumpR2P} onClick={() => setPumpR2P(v => !v)} disabled={isUiFrozen} />
          <PipeSegment flowing={pumpR2P} />
          <PurificationTank
            active={purificationActive}
            onClick={() => setPurificationActive(v => !v)}
            disabled={isUiFrozen}
          />
          <PipeSegment flowing={pumpP2M} attack={modbusAttack} />
          <Pump
            label="Pump 2"
            active={pumpP2M}
            attack={modbusAttack}
            onClick={() => setPumpP2M(v => !v)}
            disabled={isUiFrozen}
          />
          <PipeSegment flowing={pumpP2M} attack={modbusAttack} />
          <SideTank
            title="Main Tank"
            level={mainTankLevel}
            maxLevel={MAIN_TANK_CAPACITY}
            side="right"
            low={mainLow}
            valueLabel={`${Math.round((mainTankLevel / MAIN_TANK_CAPACITY) * 100)}%`}
            onClick={() => setPumpP2M(v => !v)}
            active={pumpP2M}
            disabled={isUiFrozen}
          />
        </div>
      </div>
    </div>
  )
}
