const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'

export async function syncHouseData(houses) {
  const payload = {
    houses: houses.map(house => ({
      house_id: house.id,
      house_name: house.name,
      amount_of_water_consumed: house.consumed,
      wallet_amount_present: house.wallet,
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

export async function syncPurificationData({ amountOfWaterPurified, purificationStatus }) {
  const payload = {
    amount_of_water_purified: amountOfWaterPurified,
    purification_status: purificationStatus,
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

export async function fetchPilferageAlerts() {
  const response = await fetch(`${API_BASE_URL}/api/houses/pilferage/latest`)
  if (!response.ok) {
    throw new Error(`Pilferage fetch failed with status ${response.status}`)
  }
  return response.json()
}
