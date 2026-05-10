const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'

export async function syncHouseData(houses) {
  const payload = {
    houses: houses.map(house => ({
      house_id: house.id,
      house_name: house.name,
      amount_of_water_consumed: house.consumed,
      wallet_amount_present: house.wallet,
      consuming: house.consuming,
    })),
  }

  const response = await fetch(`${API_BASE_URL}/api/houses/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`House sync failed with status ${response.status}`)
  }

  return response.json()
}

export async function syncPurificationData({ amountOfWaterPurified, purificationStatus, drainStatus }) {
  const payload = {
    amount_of_water_purified: amountOfWaterPurified,
    purification_status: purificationStatus,
    drain_status: drainStatus,
  }

  const response = await fetch(`${API_BASE_URL}/api/purification/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Purification sync failed with status ${response.status}`)
  }

  return response.json()
}

export async function fetchLatestPurificationData() {
  const response = await fetch(`${API_BASE_URL}/api/purification/latest`, {
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Purification fetch failed with status ${response.status}`)
  }

  return response.json()
}

export async function fetchLatestMainTankData() {
  const response = await fetch(`${API_BASE_URL}/api/main-tank/latest`, {
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Main tank fetch failed with status ${response.status}`)
  }

  return response.json()
}

export async function fetchRfidRechargeEvents(afterEventId = 0) {
  const response = await fetch(`${API_BASE_URL}/api/rfid/recharges?after_event_id=${afterEventId}`, {
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`RFID recharge fetch failed with status ${response.status}`)
  }

  return response.json()
}

export async function fetchStartupDrainStatus() {
  const response = await fetch(`${API_BASE_URL}/api/startup-drain/status`, {
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Startup drain status fetch failed with status ${response.status}`)
  }

  return response.json()
}

export async function requestSystemShutdown() {
  const response = await fetch(`${API_BASE_URL}/api/system/shutdown`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`System shutdown failed with status ${response.status}`)
  }

  return response.json()
}

export async function openHouseTap(houseId, houseName = '') {
  const response = await fetch(`${API_BASE_URL}/api/houses/tap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ house_id: houseId, house_name: houseName }),
  })

  if (!response.ok) {
    throw new Error(`Tap open request failed with status ${response.status}`)
  }

  return response.json()
}

export async function signalHouseDrain(houseDrain) {
  const response = await fetch(`${API_BASE_URL}/api/purification/house-drain`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ house_drain: houseDrain }),
  })

  if (!response.ok) {
    throw new Error(`House drain signal failed with status ${response.status}`)
  }

  return response.json()
}
