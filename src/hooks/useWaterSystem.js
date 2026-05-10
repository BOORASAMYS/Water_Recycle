import { useState, useEffect, useRef, useCallback } from 'react'
import {
  fetchLatestMainTankData,
  fetchLatestPurificationData,
  fetchRfidRechargeEvents,
  fetchStartupDrainStatus,
  requestSystemShutdown,
  signalHouseDrain,
  syncHouseData,
  syncPurificationData,
} from '../lib/waterApi'

const PURIFICATION_CAPACITY = 1000
const MAIN_TANK_CAPACITY = 500
const HOUSE_WALLET_MAX = 100
const WATER_COST_PER_LITER = 5
const FILL_RATE = 2 // ml per tick
const CONSUMPTION_RATE = 1.5
const MAIN_TANK_REFILL_START_PCT = 0.2
const MAIN_TANK_REFILL_STOP_PCT = 0.8
const MAIN_TANK_REALTIME_STALE_MS = 3000
const RFID_SYNC_INTERVAL_MS = 250
const RFID_RECHARGE_AMOUNT = 5

export function useWaterSystem() {
  const [reservoirLevel, setReservoirLevel] = useState(850)
  const [purificationLevel, setPurificationLevel] = useState(320)
  const [mainTankLevel, setMainTankLevel] = useState(0)
  const [purificationActive, setPurificationActive] = useState(true)
  const [pumpR2P, setPumpR2P] = useState(true) // reservoir to purification
  const [pumpP2M, setPumpP2M] = useState(false) // purification to main
  const [pilferageAlert, setPilferageAlert] = useState(false)
  const [pilferageActive, setPilferageActive] = useState(false)
  const [modbusAttack, setModbusAttack] = useState(false)
  const [apiAttack, setApiAttack] = useState(false)
  const [flowRateR2P, setFlowRateR2P] = useState(0)
  const [flowRateP2M, setFlowRateP2M] = useState(0)
  const [totalPurified, setTotalPurified] = useState(1240)
  const [fillTimeMain, setFillTimeMain] = useState(0)
  const [autoMode, setAutoMode] = useState(true)
  const [drainActive, setDrainActive] = useState(false)
  const [systemShutdown, setSystemShutdown] = useState(false)
  const [amountOfWaterPurified, setAmountOfWaterPurified] = useState(0)
  const [isUiFrozen, setIsUiFrozen] = useState(false)

  const [houses, setHouses] = useState([
    { id: 1, name: 'House 1', wallet: 0, consuming: false, consumed: 0, waterLevel: 0, active: true },
    { id: 2, name: 'House 2', wallet: 0, consuming: false, consumed: 0, waterLevel: 0, active: true },
    { id: 3, name: 'House 3', wallet: 0, consuming: false, consumed: 0, waterLevel: 0, active: true },
    { id: 4, name: 'House 4', wallet: 0, consuming: false, consumed: 0, waterLevel: 0, active: true },
  ])

  const tickRef = useRef(null)
  const latestHousesRef = useRef(houses)
  const lastSyncedHousesSnapshotRef = useRef(null)
  const lastSyncedPurificationSnapshotRef = useRef(null)
  const mainTankRef = useRef(mainTankLevel)
  const mainTankLevelRef = useRef(mainTankLevel)
  const purificationLevelRef = useRef(purificationLevel)
  const pumpR2PRef = useRef(pumpR2P)
  const pumpP2MRef = useRef(pumpP2M)
  const purificationActiveRef = useRef(purificationActive)
  const mainTankRealtimeEnabledRef = useRef(false)
  const lastMainTankRealtimeAtRef = useRef(0)
  const latestPurificationRef = useRef({
    amountOfWaterPurified: 0,
    purificationStatus: purificationActive ? 'ON' : 'OFF',
    drainStatus: drainActive ? 'ON' : 'OFF',
  })
  const drainRef = useRef(null)
  const drainInProgressRef = useRef(false)
  const initialDrainTimeoutRef = useRef(null)
  const initialDrainStartedRef = useRef(false)
  const drainLockPumpP2Ref = useRef(false)
  const forceMainTankMotorAfterDrainRef = useRef(false)
  const postDrainMotorRestartTimerRef = useRef(null)
  const resetAutoRestartTimerRef = useRef(null)
  const shutdownSequenceTimeoutRef = useRef(null)
  const shutdownInProgressRef = useRef(false)
  const postDrainSyncTimersRef = useRef([])
  const serverStartupDrainActiveRef = useRef(true) // blocked until backend clears it
  const initialDrainCompletedRef = useRef(false)
  const amountOfWaterPurifiedRef = useRef(0)
  const syncInFlightRef = useRef(false)
  const pilferageSound = useRef(null)
  const previousHouseConsumptionRef = useRef(new Map())
  const latestRfidEventIdRef = useRef(0)
  const lastRfidCountByHouseIdRef = useRef(new Map())
  const rfidSyncInFlightRef = useRef(false)
  const mainTankFetchInFlightRef = useRef(false)
  const rfidSyncErrorShownRef = useRef(false)
  const mainTankFetchErrorShownRef = useRef(false)
  const [purificationDisplayPct, setPurificationDisplayPct] = useState(0)
  const purificationDisplayPctRef = useRef(0)

  const houseSyncErrorShownRef = useRef(false)

  const updateHousesState = useCallback((updater) => {
    setHouses(prev => {
      const nextHouses = typeof updater === 'function' ? updater(prev) : updater
      latestHousesRef.current = nextHouses
      return nextHouses
    })
  }, [])

  const hasFreshMainTankRealtimeData = useCallback(() => {
    if (!mainTankRealtimeEnabledRef.current) return false
    return Date.now() - lastMainTankRealtimeAtRef.current <= MAIN_TANK_REALTIME_STALE_MS
  }, [])

  const syncPurificationNow = useCallback((nextPurificationState) => {
    latestPurificationRef.current = {
      ...latestPurificationRef.current,
      ...nextPurificationState,
    }

    syncPurificationData(latestPurificationRef.current).catch(error => {
      console.warn('[API ERROR] immediate purification sync failed; retrying on next sync.', error)
    })
  }, [])

  const clearPostDrainSyncTimers = useCallback(() => {
    postDrainSyncTimersRef.current.forEach(timer => clearTimeout(timer))
    postDrainSyncTimersRef.current = []
  }, [])

  const confirmPurificationRestart = useCallback((nextPurificationState) => {
    syncPurificationNow(nextPurificationState)
    clearPostDrainSyncTimers()

    postDrainSyncTimersRef.current = [500, 1500, 3500].map(delay => (
      setTimeout(() => syncPurificationNow(nextPurificationState), delay)
    ))
  }, [clearPostDrainSyncTimers, syncPurificationNow])

  const sendPlcCommand = useCallback((houseId, action) => {
    return fetch('http://localhost:8000/api/plc/control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        house_id: houseId,
        action,
      }),
    })
      .then(res => res.json())
      .then(data => {
        console.log(`PLC command sent: house ${houseId} ${action}`, data)
        return data
      })
      .catch(error => {
        console.error(`PLC command failed: house ${houseId}`, error)
        throw error
      })
  }, [])

  const dismissPilferage = useCallback(() => {
    setPilferageAlert(false)
    setPilferageActive(false)
  }, [])

  const triggerPilferage = useCallback(() => {
    if (pilferageActive || pilferageAlert) return
    setPilferageActive(true)
    
    // Play a buzzer sound
    if (!pilferageSound.current) {
      pilferageSound.current = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg')
    }
    
    // After 4 seconds, detect the pilferage and stop it
    setTimeout(() => {
      setPilferageActive(false)
      setPilferageAlert(true)
      
      if (pilferageSound.current) {
        pilferageSound.current.play().catch(e => console.error('Audio play failed', e))
      }
    }, 4000)
  }, [pilferageActive, pilferageAlert])

  const triggerModbusAttack = useCallback(() => {
    setModbusAttack(true)
    // Stop filling even when tank is low
    setPumpP2M(false)
    setTimeout(() => setModbusAttack(false), 8000)
  }, [])

  const triggerApiAttack = useCallback(() => {
    setApiAttack(true)
    // Corrupt wallet data
    updateHousesState(prev => prev.map(h => ({ ...h, wallet: Math.max(0, h.wallet - Math.random() * 30) })))
    setTimeout(() => setApiAttack(false), 6000)
  }, [updateHousesState])

  const rechargeWallet = useCallback((houseId, amount) => {
    updateHousesState(prev => prev.map(h =>
      h.id === houseId ? { ...h, wallet: Math.min(HOUSE_WALLET_MAX, h.wallet + amount) } : h
    ))
  }, [updateHousesState])

  const toggleConsumption = useCallback((houseId) => {
    updateHousesState(prev => {
      const nextHouses = prev.map(h => {
        if (h.id !== houseId) return h
        const opening = !h.consuming
        if (opening) {
          // Immediate decrement of wallet & increment of water consumed on Open Tap.
          // Main tank dependency: cap usage by available main tank water (read-only —
          // the main tank level itself is driven by the ultrasonic sensor).
          const affordable = h.wallet / WATER_COST_PER_LITER
          const available = Math.max(0, mainTankLevelRef.current)
          const usage = Math.min(1, affordable, available)
          const cost = usage * WATER_COST_PER_LITER
          return {
            ...h,
            consuming: usage > 0,
            wallet: Math.max(0, h.wallet - cost),
            consumed: h.consumed + usage,
            waterLevel: (h.waterLevel ?? 0) + usage,
          }
        }
        return { ...h, consuming: false }
      })

      syncHouseData(nextHouses).catch(error => {
        if (houseSyncErrorShownRef.current) return
        houseSyncErrorShownRef.current = true
        console.warn('[API ERROR] immediate house sync failed; retrying on next sync.', error)
      })

      // Signal house_drain to the purification ESP whenever a tap is toggled
      const nextHouseConsuming = nextHouses.find(h => h.id === houseId)?.consuming ?? false
      signalHouseDrain(nextHouseConsuming ? 'on' : 'off').catch(err => {
        console.warn('[API] house_drain signal failed', err)
      })

      return nextHouses
    })
  }, [updateHousesState])

  const setPumpP2WithUserIntent = useCallback((value) => {
    drainLockPumpP2Ref.current = false
    setPumpP2M(prev => (typeof value === 'function' ? value(prev) : value))
  }, [])

  const resetSystem = useCallback(() => {
    if (resetAutoRestartTimerRef.current) {
      clearTimeout(resetAutoRestartTimerRef.current)
      resetAutoRestartTimerRef.current = null
    }

    setReservoirLevel(1000)
    setPurificationLevel(0)
    setMainTankLevel(0)
    // Reset purification amount to zero and sync to backend
    setAmountOfWaterPurified(0)
    amountOfWaterPurifiedRef.current = 0
    syncPurificationNow({
      amountOfWaterPurified: 0,
      purificationStatus: 'OFF',
      drainStatus: 'OFF',
    })
    // cancel any active drain
    if (drainRef.current) {
      clearInterval(drainRef.current)
      drainRef.current = null
      drainInProgressRef.current = false
    }
    drainLockPumpP2Ref.current = false
    setSystemShutdown(true)
    setDrainActive(false)
    setPurificationActive(false)
    setPumpR2P(false)
    setPumpP2M(false)
    setFlowRateR2P(0)
    setFlowRateP2M(0)
    setPilferageAlert(false)
    setPilferageActive(false)
    setModbusAttack(false)
    setApiAttack(false)
    setAutoMode(false)
    updateHousesState(prev => prev.map(h => ({ ...h, wallet: 0, consuming: false, consumed: 0, waterLevel: 0 })))

    resetAutoRestartTimerRef.current = setTimeout(() => {
      resetAutoRestartTimerRef.current = null
      setSystemShutdown(false)
      setAutoMode(true)

      if (mainTankRef.current / MAIN_TANK_CAPACITY <= MAIN_TANK_REFILL_START_PCT) {
        setPurificationActive(true)
        setPumpR2P(true)
        setPumpP2M(true)
      }
    }, 3000)
  }, [updateHousesState, syncPurificationNow])

  const startInitialDrainSequence = useCallback(() => {
    if (initialDrainStartedRef.current || drainInProgressRef.current || systemShutdown) return

    const INITIAL_DRAIN_DURATION_MS = 15000
    initialDrainStartedRef.current = true

    setDrainActive(true)
    drainInProgressRef.current = true
    drainLockPumpP2Ref.current = true
    forceMainTankMotorAfterDrainRef.current = false
    clearPostDrainSyncTimers()
    if (postDrainMotorRestartTimerRef.current) {
      clearTimeout(postDrainMotorRestartTimerRef.current)
      postDrainMotorRestartTimerRef.current = null
    }
    syncPurificationNow({
      purificationStatus: 'OFF',
      drainStatus: 'ON',
    })
    setPurificationActive(false)
    setPumpR2P(false)
    setPumpP2M(false)
    setFlowRateR2P(0)
    setFlowRateP2M(0)
    updateHousesState(prev => prev.map(h => ({ ...h, consuming: true })))

    for (let houseId = 1; houseId <= 4; houseId++) {
      sendPlcCommand(houseId, 'on').catch(error => {
        console.error(`Failed to turn on house ${houseId} motor during startup drain:`, error)
      })
    }

    initialDrainTimeoutRef.current = setTimeout(() => {
      setDrainActive(false)
      drainInProgressRef.current = false
      drainLockPumpP2Ref.current = systemShutdown
      initialDrainCompletedRef.current = true
      updateHousesState(prev => prev.map(h => ({ ...h, consuming: false })))

      for (let houseId = 1; houseId <= 4; houseId++) {
        sendPlcCommand(houseId, 'off').catch(error => {
          console.error(`Failed to turn off house ${houseId} motor after startup drain:`, error)
        })
      }

      if (!systemShutdown) {
        const mainPct = mainTankRef.current / MAIN_TANK_CAPACITY
        const mainNeedsFill = mainPct <= MAIN_TANK_REFILL_START_PCT
        setPumpP2M(mainNeedsFill)
        setPumpR2P(mainNeedsFill)
        setPurificationActive(mainNeedsFill)
        setFlowRateP2M(mainNeedsFill ? MAIN_TANK_CAPACITY / 240 : 0)
      }
      initialDrainTimeoutRef.current = null
    }, INITIAL_DRAIN_DURATION_MS)
  }, [clearPostDrainSyncTimers, confirmPurificationRestart, sendPlcCommand, syncPurificationNow, systemShutdown, updateHousesState])

  const shutdownSystem = useCallback(() => {
    if (systemShutdown || drainActive) return

    const SHUTDOWN_DRAIN_DURATION_MS = 15000
    const DRAIN_TICK_MS = 500
    const drainSteps = SHUTDOWN_DRAIN_DURATION_MS / DRAIN_TICK_MS
    const houseDrainPerStep = latestHousesRef.current.map(house => ({
      id: house.id,
      drainPerStep: (house.waterLevel ?? 0) / drainSteps,
    }))

    shutdownInProgressRef.current = true
    if (drainRef.current) {
      clearInterval(drainRef.current)
    }
    if (shutdownSequenceTimeoutRef.current) {
      clearTimeout(shutdownSequenceTimeoutRef.current)
      shutdownSequenceTimeoutRef.current = null
    }

    drainInProgressRef.current = true
    drainLockPumpP2Ref.current = true
    forceMainTankMotorAfterDrainRef.current = false
    clearPostDrainSyncTimers()
    if (postDrainMotorRestartTimerRef.current) {
      clearTimeout(postDrainMotorRestartTimerRef.current)
      postDrainMotorRestartTimerRef.current = null
    }
    syncPurificationNow({
      purificationStatus: 'OFF',
      drainStatus: 'ON',
    })
    setDrainActive(true)
    setPurificationActive(false)
    setPumpR2P(false)
    setPumpP2M(false)
    setFlowRateR2P(0)
    setFlowRateP2M(0)
    setPilferageActive(false)
    setApiAttack(false)
    setModbusAttack(false)
    setAutoMode(false)
    updateHousesState(prev => prev.map(house => ({ ...house, consuming: true })))

    for (let houseId = 1; houseId <= 4; houseId++) {
      sendPlcCommand(houseId, 'on').catch(error => {
        console.error(`Failed to turn on house ${houseId} motor during shutdown drain:`, error)
      })
    }

    // PLC relay-off and backend shutdown are handled together inside the setInterval
    // completion block below — no separate setTimeout, so there is no race condition.

    let completedSteps = 0

    drainRef.current = setInterval(() => {
      completedSteps += 1

      updateHousesState(prev => prev.map(house => {
        const houseDrain = houseDrainPerStep.find(item => item.id === house.id)?.drainPerStep ?? 0
        const nextWaterLevel = completedSteps >= drainSteps
          ? 0
          : Math.max(0, (house.waterLevel ?? 0) - houseDrain)
        const nextConsumed = completedSteps >= drainSteps
          ? Math.max(0, house.consumed - (house.waterLevel ?? 0))
          : Math.max(0, house.consumed - houseDrain)

        return {
          ...house,
          consuming: completedSteps < drainSteps,
          waterLevel: nextWaterLevel,
          consumed: nextConsumed,
        }
      }))

      if (completedSteps >= drainSteps) {
        clearInterval(drainRef.current)
        drainRef.current = null
        drainInProgressRef.current = false
        drainLockPumpP2Ref.current = true
        forceMainTankMotorAfterDrainRef.current = false
        if (postDrainMotorRestartTimerRef.current) {
          clearTimeout(postDrainMotorRestartTimerRef.current)
          postDrainMotorRestartTimerRef.current = null
        }

        // Turn off all house PLC relays — drain is complete.
        // Doing this here (not in a separate setTimeout) guarantees these OFF commands
        // always run before requestSystemShutdown(), with no race condition.
        for (let houseId = 1; houseId <= 4; houseId++) {
          sendPlcCommand(houseId, 'off').catch(error => {
            console.error(`Failed to turn off house ${houseId} motor after shutdown drain:`, error)
          })
        }

        setDrainActive(false)
        setSystemShutdown(true)
        syncPurificationNow({
          amountOfWaterPurified: amountOfWaterPurifiedRef.current,
          purificationStatus: 'OFF',
          drainStatus: 'OFF',
        })
        setPurificationActive(false)
        setPumpR2P(false)
        setPumpP2M(false)
        setFlowRateR2P(0)
        setFlowRateP2M(0)
        updateHousesState(prev => prev.map(house => ({ ...house, consuming: false })))

        requestSystemShutdown().catch(error => {
          console.error('Failed to request Raspberry Pi shutdown:', error)
        })
      }
    }, DRAIN_TICK_MS)
  }, [clearPostDrainSyncTimers, drainActive, sendPlcCommand, syncPurificationNow, systemShutdown, updateHousesState])

  const triggerDrain = useCallback(() => {
    const hasHouseWater = latestHousesRef.current.some(house => (house.waterLevel ?? 0) > 0)
    if (drainInProgressRef.current || (mainTankRef.current <= 0 && !hasHouseWater)) return

    const DRAIN_DURATION_MS = 15000
    const DRAIN_TICK_MS = 500
    const drainSteps = DRAIN_DURATION_MS / DRAIN_TICK_MS
    const houseDrainPerStep = latestHousesRef.current.map(house => ({
      id: house.id,
      drainPerStep: (house.waterLevel ?? 0) / drainSteps,
    }))

    if (drainRef.current) {
      clearInterval(drainRef.current)
    }

    drainInProgressRef.current = true
    forceMainTankMotorAfterDrainRef.current = false
    clearPostDrainSyncTimers()
    if (postDrainMotorRestartTimerRef.current) {
      clearTimeout(postDrainMotorRestartTimerRef.current)
      postDrainMotorRestartTimerRef.current = null
    }
    syncPurificationNow({
      purificationStatus: 'OFF',
      drainStatus: 'ON',
    })
    setDrainActive(true)
    drainLockPumpP2Ref.current = true
    setPurificationActive(false)
    setPumpR2P(false)
    setPumpP2M(false)
    setFlowRateR2P(0)
    setFlowRateP2M(0)

    // Turn on pump for all houses and send pump=on data via ESP
    updateHousesState(prev => prev.map(h => ({ ...h, consuming: true })))

    // Turn on all house motors (taps) via PLC commands
    for (let houseId = 1; houseId <= 4; houseId++) {
      sendPlcCommand(houseId, 'on').catch(error => {
        console.error(`Failed to turn on house ${houseId} motor:`, error)
      })
    }

    // After drain completes: turn off all house taps via PLC
    setTimeout(() => {
      updateHousesState(prev => prev.map(h => ({ ...h, consuming: false })))

      for (let houseId = 1; houseId <= 4; houseId++) {
        sendPlcCommand(houseId, 'off').catch(error => {
          console.error(`Failed to turn off house ${houseId} motor:`, error)
        })
      }
    }, DRAIN_DURATION_MS)

    let completedSteps = 0

    drainRef.current = setInterval(() => {
      completedSteps += 1

      updateHousesState(prev => prev.map(house => {
        const houseDrain = houseDrainPerStep.find(item => item.id === house.id)?.drainPerStep ?? 0
        const nextWaterLevel = completedSteps >= drainSteps
          ? 0
          : Math.max(0, (house.waterLevel ?? 0) - houseDrain)
        const nextConsumed = completedSteps >= drainSteps
          ? Math.max(0, house.consumed - (house.waterLevel ?? 0))
          : Math.max(0, house.consumed - houseDrain)

        return {
          ...house,
          consuming: completedSteps < drainSteps, // keep taps open while draining
          waterLevel: nextWaterLevel,
          consumed: nextConsumed,
        }
      }))

      if (completedSteps >= drainSteps) {
        clearInterval(drainRef.current)
        drainRef.current = null
        drainInProgressRef.current = false
        drainLockPumpP2Ref.current = systemShutdown
        forceMainTankMotorAfterDrainRef.current = false
        if (postDrainMotorRestartTimerRef.current) {
          clearTimeout(postDrainMotorRestartTimerRef.current)
          postDrainMotorRestartTimerRef.current = null
        }
        syncPurificationNow({
          amountOfWaterPurified: amountOfWaterPurifiedRef.current,
          purificationStatus: 'OFF',
          drainStatus: 'OFF',
        })
        // Do NOT auto-restart purification or pumps after drain ends.
        // Leave purification tank OFF; the user controls when to turn it back on.
        setDrainActive(false)
      }
    }, DRAIN_TICK_MS)
  }, [clearPostDrainSyncTimers, confirmPurificationRestart, sendPlcCommand, syncPurificationNow, systemShutdown, updateHousesState])

  useEffect(() => {
    // Auto-run initial drain sequence on first mount
    startInitialDrainSequence()
  }, [startInitialDrainSequence])

  useEffect(() => {
    mainTankRef.current = mainTankLevel
    mainTankLevelRef.current = mainTankLevel
  }, [mainTankLevel])

  useEffect(() => { purificationLevelRef.current = purificationLevel }, [purificationLevel])
  useEffect(() => { pumpR2PRef.current = pumpR2P }, [pumpR2P])
  useEffect(() => { pumpP2MRef.current = pumpP2M }, [pumpP2M])
  useEffect(() => { purificationActiveRef.current = purificationActive }, [purificationActive])

  // Smoothly step purificationDisplayPct toward the true backend % at 0.3% per tick
  useEffect(() => {
    const truePct = (purificationLevel / PURIFICATION_CAPACITY) * 100
    const current = purificationDisplayPctRef.current
    const diff = truePct - current
    if (Math.abs(diff) < 0.01) return
    const step = Math.sign(diff) * Math.min(Math.abs(diff), 0.3)
    const next = Math.round((current + step) * 100) / 100
    purificationDisplayPctRef.current = next
    setPurificationDisplayPct(next)
  }, [purificationLevel])

  useEffect(() => {
    return () => {
      if (drainRef.current) {
        clearInterval(drainRef.current)
        drainRef.current = null
        drainInProgressRef.current = false
      }
      if (initialDrainTimeoutRef.current) {
        clearTimeout(initialDrainTimeoutRef.current)
        initialDrainTimeoutRef.current = null
        initialDrainStartedRef.current = false
        drainInProgressRef.current = false
      }
      if (postDrainMotorRestartTimerRef.current) {
        clearTimeout(postDrainMotorRestartTimerRef.current)
        postDrainMotorRestartTimerRef.current = null
      }
      if (resetAutoRestartTimerRef.current) {
        clearTimeout(resetAutoRestartTimerRef.current)
        resetAutoRestartTimerRef.current = null
      }
      if (shutdownSequenceTimeoutRef.current) {
        clearTimeout(shutdownSequenceTimeoutRef.current)
        shutdownSequenceTimeoutRef.current = null
      }
      clearPostDrainSyncTimers()
    }
  }, [clearPostDrainSyncTimers])

  // Simulation tick
  useEffect(() => {
    tickRef.current = setInterval(() => {
      const hasLiveMainTankData = hasFreshMainTankRealtimeData()
      // Use refs for fast-changing values to avoid stale closures and interval restarts
      const mainTankLevel = mainTankLevelRef.current
      const purificationLevel = purificationLevelRef.current
      const pumpR2P = pumpR2PRef.current
      const pumpP2M = pumpP2MRef.current
      const purificationActive = purificationActiveRef.current
      const mainPct = mainTankLevel / MAIN_TANK_CAPACITY
      const mainTankNeedsFill =
        !drainLockPumpP2Ref.current &&
        !modbusAttack &&
        (
          forceMainTankMotorAfterDrainRef.current ||
          mainPct <= MAIN_TANK_REFILL_START_PCT ||
          (pumpP2M && mainPct < MAIN_TANK_REFILL_STOP_PCT)
        )
      const updateHouseConsumptionOnly = () => {
        // House consumption is updated independently from main-tank writes.
        updateHousesState(prev => prev.map(h => {
          if (!h.consuming) return h
          if (h.wallet <= 0 || mainTankLevel <= 0) return { ...h, consuming: false }
          if (apiAttack) return h

          const requestedUsage = 0.1
          const maxAffordable = h.wallet / WATER_COST_PER_LITER
          const actualUsage = Math.min(requestedUsage, maxAffordable, mainTankLevel)
          const cost = actualUsage * WATER_COST_PER_LITER
          const newWallet = Math.max(0, h.wallet - cost)

          return {
            ...h,
            wallet: newWallet,
            consumed: h.consumed + actualUsage,
            waterLevel: (h.waterLevel ?? 0) + actualUsage,
            consuming: newWallet > 0 && actualUsage > 0,
          }
        }))
      }

      if (systemShutdown) {
        forceMainTankMotorAfterDrainRef.current = false
        setPumpR2P(false)
        setPumpP2M(false)
        setPurificationActive(false)
        setFlowRateR2P(0)
        setFlowRateP2M(0)
        return
      }

      if (shutdownInProgressRef.current) {
        forceMainTankMotorAfterDrainRef.current = false
        setPumpR2P(false)
        setPumpP2M(false)
        setPurificationActive(false)
        setFlowRateR2P(0)
        setFlowRateP2M(0)
        return
      }

      if (drainInProgressRef.current) {
        setPumpR2P(false)
        setPumpP2M(false)
        setPurificationActive(false)
        setFlowRateR2P(0)
        setFlowRateP2M(0)
        return
      }

      // Condition 1: When main tank reaches 80% (MAIN_TANK_REFILL_STOP_PCT), turn off BOTH
      // the main tank motor (pumpP2M) AND the purification tank motor (pumpR2P / purificationActive).
      // Condition 2: When the main tank motor (pumpP2M) is off, the purification
      // tank motor must also be off — enforced in the purification-level block below.
      const mainTankAtStopThreshold = mainPct >= MAIN_TANK_REFILL_STOP_PCT

      if (mainTankAtStopThreshold && !forceMainTankMotorAfterDrainRef.current) {
        // Main tank has reached 80% — shut down both motors immediately
        forceMainTankMotorAfterDrainRef.current = false
        setPumpP2M(false)
        setPumpR2P(false)
        setPurificationActive(false)
        setFlowRateP2M(0)
        setFlowRateR2P(0)
        // Skip the rest of the tick — nothing should flow until tank drops below 20%
        updateHouseConsumptionOnly()
        return
      }

      setReservoirLevel(prev => {
        let level = prev

        if (pumpR2P && level > 0 && purificationLevel < PURIFICATION_CAPACITY) {
          const flow = (2 + Math.random() * 1) / 5
          setFlowRateR2P(flow * 10) // display as per-second rate
          level = Math.max(0, level - flow)
          setPurificationLevel(pl => {
            const newPl = Math.min(PURIFICATION_CAPACITY, pl + flow * 0.95)
            if (purificationActive) setTotalPurified(tp => tp + flow * 0.95)
            return newPl
          })
        } else {
          setFlowRateR2P(0)
        }

        // Auto refill reservoir slowly
        if (autoMode && level < 200) level = Math.min(1000, level + 1)
        return level
      })

      setPurificationLevel(prev => {
        let level = prev
        // Turn ON when: triggered at <=20% OR already running and still below 80% stop threshold
        const shouldKeepRunning = pumpP2M && mainPct < MAIN_TANK_REFILL_STOP_PCT && !drainLockPumpP2Ref.current && !modbusAttack
        const motorsActive = mainTankNeedsFill || shouldKeepRunning

        if (motorsActive) {
          // Main tank motor ON -> purification tank motor must also be ON
          setPumpP2M(true)
          setPumpR2P(true)
          setPurificationActive(true)
          const flow = MAIN_TANK_CAPACITY / 1200 // 5x more ticks per second, same real fill time
          const actualFlow = Math.min(level, flow)
          setFlowRateP2M(actualFlow * 10) // display as per-second rate
          level = Math.max(0, level - actualFlow)
          if (actualFlow > 0) setFillTimeMain(t => t + 1/300)
        } else if (!pumpP2M) {
          // Motors already off - just zero out flow rates, do NOT force-set motor state
          setFlowRateP2M(0)
          setFlowRateR2P(0)
        }
        return level
      })

      // House consumption (paused while drain in progress so drain effect is visible)
      // Each tick (100ms): consuming houses use 0.1L and are charged ₹0.5 (= 0.1L × ₹5/L).
      // This matches the new zip's 0.5L per 500ms tick at the same real-world drain rate.
      // When wallet reaches 0 the tap auto-closes and water increment stops.
      updateHousesState(prev => prev.map(h => {
        if (drainInProgressRef.current) {
          return { ...h, consuming: true }
        }

        if (!h.consuming) return h
        if (h.wallet <= 0 || mainTankLevel <= 0) return { ...h, consuming: false }
        if (apiAttack) return h

        // 1 Liter = ₹5; consume 0.1L per 100ms tick (same rate as 0.5L per 500ms tick)
        const requestedUsage = 0.1
        const maxAffordable = h.wallet / WATER_COST_PER_LITER
        const actualUsage = Math.min(requestedUsage, maxAffordable, mainTankLevel)
        const cost = actualUsage * WATER_COST_PER_LITER
        const newWallet = Math.max(0, h.wallet - cost)

        return {
          ...h,
          wallet: newWallet,
          consumed: h.consumed + actualUsage,
          waterLevel: (h.waterLevel ?? 0) + actualUsage,
          consuming: newWallet > 0 && actualUsage > 0,
        }
      }))

      // Pilferage drains main tank to reservoir
      if (pilferageActive && !hasLiveMainTankData) {
        setMainTankLevel(mt => {
          const amount = Math.min(mt, 2) // same 10 units/sec as before (5x ticks × 2 = 10/s)
          setReservoirLevel(r => Math.min(1000, r + amount))
          return mt - amount
        })
      }

      // After initial drain completes, when purification tank is ON, increase
      // the purification tank's water consumption by 0.2% per tick.
      if (initialDrainCompletedRef.current && purificationActiveRef.current && !drainInProgressRef.current && !systemShutdown) {
        setAmountOfWaterPurified(prev => prev + 0.2)
      }
    }, 100)

    return () => {
      clearInterval(tickRef.current)
    }
  }, [modbusAttack, apiAttack, pilferageActive, autoMode, systemShutdown, updateHousesState, hasFreshMainTankRealtimeData])

  useEffect(() => {
    latestHousesRef.current = houses
  }, [houses])

  useEffect(() => {
    houses.forEach(house => {
      if (shutdownInProgressRef.current) {
        previousHouseConsumptionRef.current.set(house.id, house.consuming)
        return
      }

      const previousConsuming = previousHouseConsumptionRef.current.get(house.id)

      if (previousConsuming === undefined) {
        previousHouseConsumptionRef.current.set(house.id, house.consuming)
        return
      }

      if (previousConsuming !== house.consuming) {
        sendPlcCommand(house.id, house.consuming ? 'on' : 'off').catch(() => {})
        signalHouseDrain(house.consuming ? 'on' : 'off').catch(() => {})
      }

      previousHouseConsumptionRef.current.set(house.id, house.consuming)
    })
  }, [houses, sendPlcCommand])

  useEffect(() => { amountOfWaterPurifiedRef.current = amountOfWaterPurified }, [amountOfWaterPurified])

  useEffect(() => {
    latestPurificationRef.current = {
      amountOfWaterPurified: amountOfWaterPurified,
      purificationStatus: purificationActive ? 'ON' : 'OFF',
      drainStatus: drainActive ? 'ON' : 'OFF',
    }
  }, [totalPurified, purificationActive, drainActive, amountOfWaterPurified])

  useEffect(() => {
    const syncToBackend = () => {
      if (syncInFlightRef.current) return

      const currentHouses = latestHousesRef.current
      const currentPurification = latestPurificationRef.current

      // Only sync houses if data has actually changed
      const housesSnapshot = JSON.stringify(currentHouses.map(h => ({
        id: h.id, wallet: Math.round(h.wallet * 100), consumed: Math.round(h.consumed * 100),
        consuming: h.consuming, waterLevel: Math.round((h.waterLevel ?? 0) * 100),
      })))
      const purificationSnapshot = JSON.stringify(currentPurification)

      const housesChanged = housesSnapshot !== lastSyncedHousesSnapshotRef.current
      const purificationChanged = purificationSnapshot !== lastSyncedPurificationSnapshotRef.current

      if (!housesChanged && !purificationChanged) return

      syncInFlightRef.current = true

      const promises = []
      if (housesChanged) promises.push(syncHouseData(currentHouses))
      if (purificationChanged) promises.push(syncPurificationData(currentPurification))

      Promise.all(promises)
        .then(() => {
          houseSyncErrorShownRef.current = false
          if (housesChanged) lastSyncedHousesSnapshotRef.current = housesSnapshot
          if (purificationChanged) lastSyncedPurificationSnapshotRef.current = purificationSnapshot
        })
        .catch(error => {
          if (houseSyncErrorShownRef.current) return
          houseSyncErrorShownRef.current = true
          console.warn('[API ERROR] backend data sync failed; retrying on next poll.', error)
        })
        .finally(() => {
          syncInFlightRef.current = false
        })
    }

    syncToBackend()
    const interval = setInterval(syncToBackend, 250)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const applyRfidRecharges = () => {
      if (rfidSyncInFlightRef.current) return

      rfidSyncInFlightRef.current = true

      fetchRfidRechargeEvents(latestRfidEventIdRef.current)
        .then(data => {
          rfidSyncErrorShownRef.current = false
          const events = Array.isArray(data?.events) ? data.events : []
          const counts = data?.counts && typeof data.counts === 'object' ? data.counts : {}
          const rechargeByHouseId = new Map()

          if (events.length > 0) {
            events.forEach(event => {
              const houseId = Number(event.house_id)
              const amount = Number(event.amount || 0)

              if (!Number.isFinite(houseId) || amount <= 0) return

              rechargeByHouseId.set(
                houseId,
                (rechargeByHouseId.get(houseId) ?? 0) + amount,
              )
            })
          }

          Object.entries(counts).forEach(([houseIdKey, countValue]) => {
            const houseId = Number(houseIdKey)
            const currentCount = Number(countValue)

            if (!Number.isFinite(houseId) || !Number.isFinite(currentCount)) return

            const previousCount = lastRfidCountByHouseIdRef.current.get(houseId)

            if (previousCount === undefined) {
              lastRfidCountByHouseIdRef.current.set(houseId, currentCount)
              return
            }

            if (currentCount < previousCount) {
              lastRfidCountByHouseIdRef.current.set(houseId, currentCount)
              return
            }

            if (currentCount > previousCount) {
              const rechargeFromCount = (currentCount - previousCount) * RFID_RECHARGE_AMOUNT
              const rechargeFromEvents = rechargeByHouseId.get(houseId) ?? 0

              rechargeByHouseId.set(
                houseId,
                Math.max(rechargeFromEvents, rechargeFromCount),
              )
            }

            lastRfidCountByHouseIdRef.current.set(houseId, currentCount)
          })

          if (rechargeByHouseId.size > 0) {
            updateHousesState(prev => prev.map(house => {
              const houseRecharge = rechargeByHouseId.get(house.id) ?? 0

              if (houseRecharge <= 0) return house

              return {
                ...house,
                wallet: Math.min(HOUSE_WALLET_MAX, house.wallet + houseRecharge),
              }
            }))
          }

          latestRfidEventIdRef.current = Number(data?.last_event_id ?? latestRfidEventIdRef.current)
        })
        .catch(error => {
          if (rfidSyncErrorShownRef.current) return
          rfidSyncErrorShownRef.current = true
          console.warn('[API ERROR] rfid recharge sync failed; retrying on next poll.', error)
        })
        .finally(() => {
          rfidSyncInFlightRef.current = false
        })
    }

    applyRfidRecharges()
    const interval = setInterval(applyRfidRecharges, RFID_SYNC_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [updateHousesState])

  // Poll backend startup-drain status; block main tank motor until server confirms drain is done
  useEffect(() => {
    // Also enforce client-side: lock pumpP2M for the first 15 seconds on mount
    drainLockPumpP2Ref.current = true
    serverStartupDrainActiveRef.current = true

    // Use a ref so the interval id is available inside the poll closure immediately
    const intervalRef = { current: null }

    const poll = () => {
      fetchStartupDrainStatus()
        .then(data => {
          if (data?.startup_drain_active === false) {
            serverStartupDrainActiveRef.current = false
            drainLockPumpP2Ref.current = false
            clearInterval(intervalRef.current)
          }
        })
        .catch(() => {
          // Backend not reachable yet — fall back to client-side 15s timer
        })
    }

    // Fallback: always release after 15s even if backend is unreachable
    const fallbackTimer = setTimeout(() => {
      serverStartupDrainActiveRef.current = false
      drainLockPumpP2Ref.current = false
    }, 15000)

    poll()
    intervalRef.current = setInterval(poll, 1000)

    return () => {
      clearInterval(intervalRef.current)
      clearTimeout(fallbackTimer)
    }
  }, [])

  useEffect(() => {
    const syncMainTankFromBackend = () => {
      if (mainTankFetchInFlightRef.current) return

      mainTankFetchInFlightRef.current = true

      Promise.all([
        fetchLatestMainTankData(),
        fetchLatestPurificationData(),
      ])
        .then(([mainTankData, purificationData]) => {
          mainTankFetchErrorShownRef.current = false

          const mainTank = mainTankData?.main_tank ?? {}
          const purification = purificationData?.purification ?? {}
          const nextMainTankLevel = Number(mainTank.main_tank_level)
          const remoteUiLockState = String(
            purification.ui_lock_state ??
            (purification.ui_lock_active ? 'ON' : 'OFF'),
          ).toUpperCase()

          setIsUiFrozen(remoteUiLockState === 'ON')

          if (Number.isFinite(nextMainTankLevel)) {
            mainTankRealtimeEnabledRef.current = true
            lastMainTankRealtimeAtRef.current = Date.now()
            const clampedLevel = Math.max(0, Math.min(MAIN_TANK_CAPACITY, nextMainTankLevel))
            setMainTankLevel(clampedLevel)

            // Immediately update main tank motor (pumpP2M) based on fresh real-time data
            // so the purification tank motor also reacts without waiting for the next sim tick
            if (!drainLockPumpP2Ref.current && !drainInProgressRef.current) {
              const mainPct = clampedLevel / MAIN_TANK_CAPACITY
              const mainTankAtStop = mainPct >= MAIN_TANK_REFILL_STOP_PCT
              if (mainTankAtStop) {
                // Tank reached 80% — shut both motors off immediately
                setPumpP2M(false)
                setPumpR2P(false)
                setPurificationActive(false)
              } else if (
                forceMainTankMotorAfterDrainRef.current ||
                mainPct <= MAIN_TANK_REFILL_START_PCT ||
                (pumpP2M && mainPct < MAIN_TANK_REFILL_STOP_PCT)
              ) {
                // Tank needs filling — turn main tank motor on immediately
                setPumpP2M(true)
                setPumpR2P(true)
                setPurificationActive(true)
              }
              // NOTE: no else-branch here — do not force motors off when level is between 20-80%.
              // Motors stay in whatever state they are; only the <=20% trigger and >=80% stop manage transitions.
            }
          }
        })
        .catch(error => {
          if (mainTankFetchErrorShownRef.current) return
          mainTankFetchErrorShownRef.current = true
          console.warn('[API ERROR] main tank fetch failed; retrying on next poll.', error)
        })
        .finally(() => {
          mainTankFetchInFlightRef.current = false
        })
    }

    syncMainTankFromBackend()
    const interval = setInterval(syncMainTankFromBackend, 200)

    return () => clearInterval(interval)
  }, [setPumpP2M, setPumpR2P, setPurificationActive])

  return {
    reservoirLevel, setReservoirLevel,
    purificationLevel,
    purificationDisplayPct,
    mainTankLevel,
    mainTankPercent: Math.round((mainTankLevel / MAIN_TANK_CAPACITY) * 100),
    purificationActive, setPurificationActive,
    pumpR2P, setPumpR2P,
    pumpP2M, setPumpP2M: setPumpP2WithUserIntent,
    pilferageAlert, pilferageActive, setPilferageActive,
    modbusAttack, apiAttack,
    flowRateR2P, flowRateP2M,
    totalPurified,
    fillTimeMain,
    autoMode, setAutoMode,
    isUiFrozen,
    houses,
    dismissPilferage,
    triggerPilferage,
    triggerModbusAttack,
    triggerApiAttack,
    triggerDrain,
    shutdownSystem,
    rechargeWallet,
    toggleConsumption,
    resetSystem,
    PURIFICATION_CAPACITY,
    MAIN_TANK_CAPACITY,
    HOUSE_WALLET_MAX,
  }
}
