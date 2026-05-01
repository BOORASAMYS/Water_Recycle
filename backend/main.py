import logging
from datetime import datetime, timezone
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

import fastapi
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


app = fastapi.FastAPI(
    title="Water Management ESP Bridge API",
    version="1.0.0",
    description="Receives house water data from the frontend and forwards it to ESP nodes.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("water-management")

# Fill these IP values when your ESP boards are ready.
# ESP code expects: /set?house=<id>&consumed=<liters>&price=<wallet_amount>
# Example: 1: {"ip": "192.168.0.5", "path": "/set"}
ESP_NODES = {
    1: {"ip": "192.168.0.4", "path": "/set"},
    2: {"ip": "192.168.0.5", "path": "/set"},
    3: {"ip": "192.168.0.6", "path": "/set"},
    4: {"ip": "192.168.0.7", "path": "/set"},
}

PURIFICATION_ESP_NODE = {"ip": "", "path": "/set"}

latest_house_data: dict[int, dict[str, Any]] = {}
latest_purification_data: dict[str, Any] = {}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class HouseWaterData(BaseModel):
    house_id: int = Field(..., ge=1)
    house_name: str
    amount_of_water_consumed: float = Field(..., ge=0)
    wallet_amount_present: float = Field(..., ge=0)


class HouseSyncRequest(BaseModel):
    houses: list[HouseWaterData]


class PurificationSyncRequest(BaseModel):
    amount_of_water_purified: float = Field(..., ge=0)
    purification_status: str = Field(..., pattern="^(ON|OFF)$")


def build_esp_url(ip: str, path: str) -> str:
    base_url = ip if ip.startswith(("http://", "https://")) else f"http://{ip}"
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def build_esp_set_url(house: HouseWaterData, ip: str, path: str) -> str:
    query = urlencode(
        {
            "house": house.house_id,
            "consumed": round(house.amount_of_water_consumed, 2),
            "price": round(house.wallet_amount_present, 2),
        }
    )
    return f"{build_esp_url(ip, path)}?{query}"


def build_purification_esp_url(payload: PurificationSyncRequest, ip: str, path: str) -> str:
    query = urlencode(
        {
            "purified": round(payload.amount_of_water_purified, 2),
            "status": payload.purification_status,
        }
    )
    return f"{build_esp_url(ip, path)}?{query}"


def send_purification_to_esp(payload: PurificationSyncRequest) -> dict[str, Any]:
    ip = PURIFICATION_ESP_NODE["ip"].strip()

    if not ip:
        logger.info("Purification ESP skipped | reason=ESP IP is blank")
        return {
            "esp_ip": "",
            "forwarded": False,
            "reason": "ESP IP is blank",
        }

    url = build_purification_esp_url(payload, ip, PURIFICATION_ESP_NODE["path"])
    logger.info("Purification ESP send | url=%s", url)

    try:
        with urlopen(url, timeout=3) as response:
            esp_response = response.read().decode("utf-8", errors="replace")
            logger.info(
                "Purification ESP response | status=%s | body=%s",
                response.status,
                esp_response,
            )
            return {
                "esp_ip": ip,
                "esp_url": url,
                "forwarded": True,
                "method": "GET",
                "status_code": response.status,
                "esp_response": esp_response,
            }
    except URLError as error:
        logger.warning("Purification ESP error | url=%s | error=%s", url, error)
        return {
            "esp_ip": ip,
            "esp_url": url,
            "forwarded": False,
            "error": str(error),
        }


def send_to_esp(house: HouseWaterData) -> dict[str, Any]:
    esp_config = ESP_NODES.get(house.house_id, {"ip": "", "path": "/set"})
    ip = esp_config["ip"].strip()

    if not ip:
        logger.info("ESP skipped | house=%s | reason=ESP IP is blank", house.house_id)
        return {
            "house_id": house.house_id,
            "esp_ip": "",
            "forwarded": False,
            "reason": "ESP IP is blank",
        }

    url = build_esp_set_url(house, ip, esp_config["path"])
    logger.info("ESP send | house=%s | url=%s", house.house_id, url)

    try:
        with urlopen(url, timeout=3) as response:
            esp_response = response.read().decode("utf-8", errors="replace")
            logger.info(
                "ESP response | house=%s | status=%s | body=%s",
                house.house_id,
                response.status,
                esp_response,
            )
            return {
                "house_id": house.house_id,
                "esp_ip": ip,
                "esp_url": url,
                "forwarded": True,
                "method": "GET",
                "status_code": response.status,
                "esp_response": esp_response,
            }
    except URLError as error:
        logger.warning("ESP error | house=%s | url=%s | error=%s", house.house_id, url, error)
        return {
            "house_id": house.house_id,
            "esp_ip": ip,
            "esp_url": url,
            "forwarded": False,
            "error": str(error),
        }


@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "service": "water-management-esp-bridge"}


@app.post("/api/houses/sync")
def sync_house_data(payload: HouseSyncRequest) -> dict[str, Any]:
    received_at = utc_now()
    forwarding_results = []

    logger.info("House sync received | count=%s", len(payload.houses))

    for house in payload.houses:
        logger.info(
            "House data | house=%s | name=%s | consumed=%.2f | wallet=%.2f",
            house.house_id,
            house.house_name,
            house.amount_of_water_consumed,
            house.wallet_amount_present,
        )
        latest_house_data[house.house_id] = {
            **house.model_dump(),
            "received_at": received_at,
        }
        forwarding_results.append(send_to_esp(house))

    return {
        "status": "ok",
        "received_at": received_at,
        "houses_received": len(payload.houses),
        "esp_forwarding": forwarding_results,
    }


@app.post("/api/purification/sync")
def sync_purification_data(payload: PurificationSyncRequest) -> dict[str, Any]:
    received_at = utc_now()
    latest_purification_data.clear()
    latest_purification_data.update(
        {
            **payload.model_dump(),
            "received_at": received_at,
        }
    )

    logger.info(
        "Purification data | purified=%.2f | status=%s",
        payload.amount_of_water_purified,
        payload.purification_status,
    )

    return {
        "status": "ok",
        "received_at": received_at,
        "esp_forwarding": send_purification_to_esp(payload),
    }


@app.get("/api/purification/latest")
def get_latest_purification_data() -> dict[str, Any]:
    return {
        "status": "ok",
        "purification": latest_purification_data,
        "esp_node": PURIFICATION_ESP_NODE,
    }


@app.get("/api/houses/latest")
def get_latest_house_data() -> dict[str, Any]:
    return {
        "status": "ok",
        "houses": list(latest_house_data.values()),
        "esp_nodes": ESP_NODES,
    }
