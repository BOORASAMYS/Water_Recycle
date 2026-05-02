import { useState, useEffect, useRef, useCallback } from 'react'
import { syncHouseData, syncPurificationData } from '../lib/waterApi'

const PURIFICATION_CAPACITY = 1000
const MAIN_TANK_CAPACITY = 500
const HOUSE_WALLET_MAX = 100
const WATER_COST_PER_LITER = 5
const FILL_RATE = 2 // ml per tick
const CONSUMPTION_RATE = 1.5
const MAIN_TANK_REFILL_START_PCT = 0.2
const MAIN_TANK_REFILL_STOP_PCT = 1.0

let apiWarningShown = false

const logApiErrorOnce = (label, error) => {
  if (apiWarningShown) return
  apiWarningShown = true
  console.warn(`[API ERROR] ${label}. Start the Python backend if it is not running.`, error)
}

export function useWaterSystem() {
  const [reservoirLevel, setReservoirLevel] = useState(850)
  const [purificationLevel, setPurificationLevel] = useState(320)
  const [mainTankLevel, setMainTankLevel] = useState(410)
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

  const [houses, setHouses] = useState([
    { id: 1, name: 'House 1', wallet: 75, consuming: false, consumed: 12.5, waterLevel: 18, active: true },
    { id: 2, name: 'House 2', wallet: 42, consuming: true, consumed: 28.0, waterLevel: 26, active: true },
    { id: 3, name: 'House 3', wallet: 18, consuming: false, consumed: 45.5, waterLevel: 12, active: true },
    { id: 4, name: 'House 4', wallet: 60, consuming: true, consumed: 8.0, waterLevel: 22, active: true },
  ])

  const tickRef = useRef(null)
  const latestHousesRef = useRef(houses)
  const mainTankRef = useRef(mainTankLevel)
  const latestPurificationRef = useRef({
    amountOfWaterPurified: totalPurified,
    purificationStatus: purificationActive ? 'ON' : 'OFF',
  })
  const drainRef = useRef(null)
  const drainInProgressRef = useRef(false)
  const drainLockPumpP2Ref = useRef(false)
  const syncInFlightRef = useRef(false)
  const backendSyncEnabledRef = useRef(true)
  const pilferageSound = useRef(null)

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
    setHouses(prev => prev.map(h => ({ ...h, wallet: Math.max(0, h.wallet - Math.random() * 30) })))
    setTimeout(() => setApiAttack(false), 6000)
  }, [])

  const rechargeWallet = useCallback((houseId, amount) => {
    setHouses(prev => prev.map(h =>
      h.id === houseId ? { ...h, wallet: Math.min(HOUSE_WALLET_MAX, h.wallet + amount) } : h
    ))
  }, [])

  const toggleConsumption = useCallback((houseId) => {
    setHouses(prev => prev.map(h =>
      h.id === houseId ? { ...h, consuming: !h.consuming } : h
    ))
  }, [])

  const setPumpP2WithUserIntent = useCallback((value) => {
    drainLockPumpP2Ref.current = false
    setPumpP2M(prev => (typeof value === 'function' ? value(prev) : value))
  }, [])

  const resetSystem = useCallback(() => {
    setReservoirLevel(1000)
    setPurificationLevel(0)
    setMainTankLevel(0)
    // cancel any active drain
    if (drainRef.current) {
      clearInterval(drainRef.current)
      drainRef.current = null
      drainInProgressRef.current = false
    }
    drainLockPumpP2Ref.current = false
    setPurificationActive(false)
    setPumpR2P(false)
    setPumpP2M(false)
    setFlowRateR2P(0)
    setFlowRateP2M(0)
    setPilferageAlert(false)
    setPilferageActive(false)
    setModbusAttack(false)
    setApiAttack(false)
    setHouses(prev => prev.map(h => ({ ...h, wallet: 100, consuming: false, consumed: 0, waterLevel: 0 })))
    
    // Turn motors on after 5 seconds
    setTimeout(() => {
      setPurificationActive(true)
      setPumpR2P(true)
    }, 5000)
  }, [])

  const triggerDrain = useCallback(() => {
    if (drainInProgressRef.current || mainTankRef.current <= 0) return

    const DRAIN_DURATION_MS = 7000
    const DRAIN_TICK_MS = 500
    const drainSteps = DRAIN_DURATION_MS / DRAIN_TICK_MS
    const drainPerStep = mainTankRef.current / drainSteps
    const houseDrainPerStep = latestHousesRef.current.map(house => ({
      id: house.id,
      drainPerStep: (house.waterLevel ?? 0) / drainSteps,
    }))

    if (drainRef.current) {
      clearInterval(drainRef.current)
    }

    drainInProgressRef.current = true
    drainLockPumpP2Ref.current = true
    setPurificationActive(false)
    setPumpR2P(false)
    setPumpP2M(false)
    setFlowRateR2P(0)
    setFlowRateP2M(0)

    let completedSteps = 0

    drainRef.current = setInterval(() => {
      completedSteps += 1

      setMainTankLevel(prev => {
        if (completedSteps >= drainSteps) return 0
        return Math.max(0, prev - drainPerStep)
      })

      setHouses(prev => prev.map(house => {
        const houseDrain = houseDrainPerStep.find(item => item.id === house.id)?.drainPerStep ?? 0

        return {
          ...house,
          consuming: false,
          waterLevel: completedSteps >= drainSteps
            ? 0
            : Math.max(0, (house.waterLevel ?? 0) - houseDrain),
        }
      }))

      if (completedSteps >= drainSteps) {
        clearInterval(drainRef.current)
        drainRef.current = null
        drainInProgressRef.current = false
      }
    }, DRAIN_TICK_MS)
  }, [])

  useEffect(() => {
    // Auto-run reset system on initial mount
    resetSystem()
  }, [resetSystem])

  useEffect(() => {
    mainTankRef.current = mainTankLevel
  }, [mainTankLevel])

  useEffect(() => {
    return () => {
      if (drainRef.current) {
        clearInterval(drainRef.current)
        drainRef.current = null
        drainInProgressRef.current = false
      }
    }
  }, [])

  // Simulation tick
  useEffect(() => {
    tickRef.current = setInterval(() => {
      if (drainInProgressRef.current) {
        setPumpR2P(false)
        setPumpP2M(false)
        setPurificationActive(false)
        setFlowRateR2P(0)
        setFlowRateP2M(0)
        return
      }

      setReservoirLevel(prev => {
        let level = prev
        if (pumpR2P && level > 0 && purificationLevel < PURIFICATION_CAPACITY) {
          const flow = 2 + Math.random() * 1
          setFlowRateR2P(flow)
          level = Math.max(0, level - flow)
          setPurificationLevel(pl => {
            const newPl = Math.min(PURIFICATION_CAPACITY, pl + flow * 0.95)
            if (purificationActive) setTotalPurified(tp => tp + flow * 0.95)
            return newPl
          })
        } else {
          setFlowRateR2P(0)
        }
        
        // Stop pumps when main tank reaches 100%
        if (mainTankLevel >= MAIN_TANK_CAPACITY) {
          setPumpR2P(false)
          setPurificationActive(false)
        }
        
        // Auto refill reservoir slowly
        if (autoMode && level < 200) level = Math.min(1000, level + 5)
        return level
      })

      setPurificationLevel(prev => {
        let level = prev
        // Refill main tank with hysteresis so it starts early enough and
        // doesn't rapidly toggle near the stop threshold.
        const mainPct = mainTankLevel / MAIN_TANK_CAPACITY
        const shouldFillMain =
          !drainLockPumpP2Ref.current &&
          !modbusAttack &&
          level > 50 &&
          (pumpP2M ? mainPct < MAIN_TANK_REFILL_STOP_PCT : mainPct <= MAIN_TANK_REFILL_START_PCT)

        if (shouldFillMain) {
          setPumpP2M(true)
          const flow = MAIN_TANK_CAPACITY / 240 // Takes 2 minutes (120s = 240 ticks)
          setFlowRateP2M(flow)
          level = Math.max(0, level - flow)
          setMainTankLevel(mt => {
            const newMt = Math.min(MAIN_TANK_CAPACITY, mt + flow)
            setFillTimeMain(t => t + 1/60)
            return newMt
          })
        } else {
          setPumpP2M(false)
          setFlowRateP2M(0)
        }
        return level
      })

      // House consumption (paused while drain in progress so drain effect is visible)
      setHouses(prev => prev.map(h => {
        if (drainInProgressRef.current) return h

        if (!h.consuming || h.wallet <= 0 || mainTankLevel <= 0) return { ...h, consuming: h.wallet > 0 ? h.consuming : false }
        if (apiAttack) return h

        // 1 unit of main tank = 1 Liter = Rs. 5
        // Consume 0.5 Liters per tick (so the tank doesn't drain too fast, 4 houses * 0.5 = 2.0 L/tick)
        const requestedUsage = 0.5
        const maxAffordable = h.wallet / WATER_COST_PER_LITER
        const actualUsage = Math.min(requestedUsage, maxAffordable, mainTankLevel)
        const cost = actualUsage * WATER_COST_PER_LITER
        const newWallet = Math.max(0, h.wallet - cost)
        
        setMainTankLevel(mt => Math.max(0, mt - actualUsage))
        
        return { 
          ...h, 
          wallet: newWallet, 
          consumed: h.consumed + actualUsage, 
          waterLevel: (h.waterLevel ?? 0) + actualUsage,
          consuming: newWallet > 0 
        }
      }))

      // Pilferage drains main tank to reservoir
      if (pilferageActive) {
        setMainTankLevel(mt => {
          const amount = Math.min(mt, 10) // Drain 20 units/sec
          setReservoirLevel(r => Math.min(1000, r + amount))
          return mt - amount
        })
      }
    }, 500)

    return () => {
      clearInterval(tickRef.current)
    }
  }, [pumpR2P, pumpP2M, purificationActive, modbusAttack, apiAttack, pilferageActive, autoMode, mainTankLevel, purificationLevel])

  useEffect(() => {
    latestHousesRef.current = houses
  }, [houses])

  useEffect(() => {
    latestPurificationRef.current = {
      amountOfWaterPurified: totalPurified,
      purificationStatus: purificationActive ? 'ON' : 'OFF',
    }
  }, [totalPurified, purificationActive])

  useEffect(() => {
    const syncToBackend = () => {
      if (!backendSyncEnabledRef.current || syncInFlightRef.current) return

      syncInFlightRef.current = true
      Promise.all([
        syncHouseData(latestHousesRef.current),
        syncPurificationData(latestPurificationRef.current),
      ])
        .catch(error => {
          backendSyncEnabledRef.current = false
          logApiErrorOnce('backend data sync', error)
        })
        .finally(() => {
          syncInFlightRef.current = false
        })
    }

    syncToBackend()
    const interval = setInterval(syncToBackend, 1000)

    return () => clearInterval(interval)
  }, [])

  return {
    reservoirLevel, setReservoirLevel,
    purificationLevel,
    mainTankLevel,
    purificationActive, setPurificationActive,
    pumpR2P, setPumpR2P,
    pumpP2M, setPumpP2M: setPumpP2WithUserIntent,
    pilferageAlert, pilferageActive,
    modbusAttack, apiAttack,
    flowRateR2P, flowRateP2M,
    totalPurified,
    fillTimeMain,
    autoMode, setAutoMode,
    houses,
    dismissPilferage,
    triggerPilferage,
    triggerModbusAttack,
    triggerApiAttack,
    triggerDrain,
    rechargeWallet,
    toggleConsumption,
    resetSystem,
    PURIFICATION_CAPACITY,
    MAIN_TANK_CAPACITY,
    HOUSE_WALLET_MAX,
  }
}
