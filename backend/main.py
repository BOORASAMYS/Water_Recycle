import logging
import json
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

import fastapi
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pymodbus.client import ModbusTcpClient


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
logger.setLevel(logging.INFO)

# PLC (Modbus) Client Configuration
PLC_HOST = "192.168.0.10"
PLC_PORT = 502
PLC_UNIT_ID = 0

plc_client = ModbusTcpClient(PLC_HOST, port=PLC_PORT, timeout=3)
plc_connected = False


def reset_plc_connection() -> None:
    """Close the PLC socket so the next request starts from a clean connection."""
    global plc_connected
    try:
        plc_client.close()
    except Exception:
        pass
    plc_connected = False

def connect_plc():
    """Establish connection to PLC"""
    global plc_connected
    try:
        reset_plc_connection()
        if plc_client.connect():
            plc_connected = True
            logger.info("PLC connected successfully")
        else:
            plc_connected = False
            logger.warning("Failed to connect to PLC")
    except Exception as e:
        logger.error("PLC connection error: %s", str(e))
        plc_connected = False

def ensure_plc_connected():
    """Ensure PLC connection is active, reconnect if needed"""
    global plc_connected
    try:
        # Check if connection is still active by attempting a read
        if not plc_client.is_socket_open():
            logger.info("PLC connection lost, attempting reconnect...")
            plc_client.close()
            if plc_client.connect():
                plc_connected = True
                logger.info("PLC reconnected successfully")
            else:
                plc_connected = False
                logger.warning("Failed to reconnect to PLC")
        else:
            plc_connected = True
    except Exception as e:
        logger.warning("PLC connection check failed: %s", str(e))
        try: #Validation passed: the backend dependencies installed successfully with the corrected pin, and backend/main.py has no current errors.
        
        
            plc_client.close()
        except:
            pass
        plc_connected = False

def send_plc_command(cmd: str) -> dict[str, Any]:
    """Send command to PLC via Modbus with retry logic"""
    global plc_connected
    
    mapping = {
        "r1on": (0, True),
        "r1off": (0, False),
        "r2on": (1, True),
        "r2off": (1, False),
        "r3on": (2, True),
        "r3off": (2, False),
        "r4on": (3, True),
        "r4off": (3, False),
        "ledon": (4, True),
        "ledoff": (4, False),
    }

    if cmd not in mapping:
        logger.warning("Invalid PLC command: %s", cmd)
        return {
            "status": "error",
            "command": cmd,
            "message": "Invalid command",
            "plc_connected": plc_connected,
        }

    max_retries = 3
    addr, val = mapping[cmd]

    for attempt in range(max_retries):
        command_client = ModbusTcpClient(PLC_HOST, port=PLC_PORT, timeout=3)
        try:
            if not command_client.connect():
                plc_connected = False
                logger.warning("PLC connect failed before command attempt %d/%d: %s", attempt + 1, max_retries, cmd)
                continue

            plc_connected = True
            result = command_client.write_coil(addr, val, device_id=PLC_UNIT_ID)
            
            if result.isError():
                logger.warning("PLC command failed (attempt %d/%d): %s - %s", attempt + 1, max_retries, cmd, result)
                continue
            else:
                logger.info("PLC command sent: %s (addr=%d, val=%s)", cmd, addr, val)
                return {
                    "status": "ok",
                    "command": cmd,
                    "address": addr,
                    "value": val,
                    "plc_connected": plc_connected,
                    "attempt": attempt + 1,
                }
        except Exception as e:
            logger.warning("PLC command error (attempt %d/%d): %s - %s", attempt + 1, max_retries, cmd, str(e))
            plc_connected = False
        finally:
            command_client.close()
    
    return {
        "status": "error",
        "command": cmd,
        "message": "PLC command failed after retries",
        "plc_connected": plc_connected,
        "plc_unit_id": PLC_UNIT_ID,
    }

# Fill these IP values when your ESP boards are ready.
# ESP code expects: /set?house=<id>&consumed=<liters>&price=<wallet_amount>
# Example: 1: {"ip": "192.168.0.5", "path": "/set"}
ESP_NODES = {
    1: {"ip": "192.168.0.4", "path": "/set", "count_path": "/count"},
    2: {"ip": "192.168.0.5", "path": "/set", "count_path": "/count"},
    3: {"ip": "192.168.0.6", "path": "/set", "count_path": "/count"},
    4: {"ip": "192.168.0.7", "path": "/set", "count_path": "/count"},
}

PURIFICATION_ESP_NODE = {"ip": "192.168.0.8", "path": "/set"}
MAIN_TANK_ESP_NODE = {"ip": "192.168.0.9", "path": "/tank"}
PURIFIER_LOCK_ESP_NODE = {"ip": "192.168.0.11", "path": "/purifier"}

latest_house_data: dict[int, dict[str, Any]] = {}
last_forwarded_house_data: dict[int, dict[str, Any]] = {}
latest_purification_data: dict[str, Any] = {}
latest_main_tank_data: dict[str, Any] = {}
latest_ui_lock_data: dict[str, Any] = {
    "ui_lock_active": False,
    "ui_lock_state": "OFF",
    "ui_lock_raw": "OFF",
    "ui_lock_received_at": None,
    "source": "esp32",
}
rfid_recharge_events: list[dict[str, Any]] = []
last_seen_rfid_counts: dict[int, int] = {}
rfid_event_counter = 0
rfid_lock = threading.Lock()
RFID_POLL_INTERVAL_SECONDS = 0.5
RFID_RECHARGE_AMOUNT = 5.0
MAIN_TANK_POLL_INTERVAL_SECONDS = 1
PURIFIER_LOCK_POLL_INTERVAL_SECONDS = 0.2
MAIN_TANK_SENSOR_MAX_PERCENT = 100.0
MAIN_TANK_UI_CAPACITY = 500.0

SHUTDOWN_DRAIN_DURATION_SECONDS = 15
shutdown_sequence_lock = threading.Lock()
shutdown_sequence_in_progress = False
shutdown_sequence_started_at: float = 0.0

# Startup drain state — disabled (no delay needed)
STARTUP_DRAIN_DURATION_SECONDS = 0
startup_drain_active = False
startup_drain_started_at: float = 0.0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class HouseWaterData(BaseModel):
    house_id: int = Field(..., ge=1)
    house_name: str
    amount_of_water_consumed: float = Field(..., ge=0)
    wallet_amount_present: float = Field(..., ge=0)
    consuming: bool = False


class HouseSyncRequest(BaseModel):
    houses: list[HouseWaterData]


class PurificationSyncRequest(BaseModel):
    amount_of_water_purified: float = Field(..., ge=0)
    purification_status: str = Field(..., pattern="^(ON|OFF)$")    
    drain_status: str = Field('OFF', pattern="^(ON|OFF)$")

class PlcControlRequest(BaseModel):
    house_id: int = Field(..., ge=1)
    action: str = Field(..., pattern="^(on|off)$")


class PlcRawCommandRequest(BaseModel):
    cmd: str = Field(..., pattern="^(r[1-4]on|r[1-4]off|ledon|ledoff)$")


# Constants for tap open logic
TAP_WATER_PER_OPEN_LITER = 1.0      # litres dispensed per tap open
TAP_COST_PER_OPEN_RUPEES = 5.0      # rupees deducted per tap open


class TapOpenRequest(BaseModel):
    house_id: int = Field(..., ge=1)
    house_name: str = ""


def build_esp_url(ip: str, path: str) -> str:
    base_url = ip if ip.startswith(("http://", "https://")) else f"http://{ip}"
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def build_esp_set_url(house: HouseWaterData, ip: str, path: str) -> str:
    tap_status = "on" if house.consuming else "off"
    query = urlencode(
        {
            "house": house.house_id,
            "consumed": round(house.amount_of_water_consumed, 2),
            "price": round(house.wallet_amount_present, 2),
            "pump": tap_status,
        }
    )
    return f"{build_esp_url(ip, path)}?{query}"


def build_house_rfid_url(ip: str, path: str) -> str:
    return build_esp_url(ip, path)


def build_main_tank_url(ip: str, path: str) -> str:
    drain_status = str(latest_purification_data.get("drain_status", "OFF")).upper()
    query = urlencode({"drain": drain_status})
    return f"{build_esp_url(ip, path)}?{query}"


def parse_main_tank_level(raw_value: str) -> float | None:
    normalized_value = raw_value.strip()

    try:
        level = float(normalized_value)
    except ValueError:
        match = re.search(r"-?\d+(?:\.\d+)?", normalized_value)
        if not match:
            return None
        level = float(match.group())

    return max(0.0, level)


def parse_on_off_state(raw_value: str) -> str | None:
    normalized_value = raw_value.strip().upper()

    if normalized_value in {"ON", "OFF"}:
        return normalized_value

    match = re.search(r"\b(ON|OFF)\b", normalized_value)
    if match:
        return match.group(1)

    return None


def convert_main_tank_percent_to_level(percent: float) -> tuple[float, float]:
    normalized_percent = max(0.0, min(MAIN_TANK_SENSOR_MAX_PERCENT, percent))
    ui_level = round(
        (normalized_percent / MAIN_TANK_SENSOR_MAX_PERCENT) * MAIN_TANK_UI_CAPACITY,
        2,
    )
    return normalized_percent, ui_level


def build_purification_esp_url(payload: PurificationSyncRequest, ip: str, path: str) -> str:
    query = urlencode(
        {
            "purified": round(payload.amount_of_water_purified, 2),
            "pump": payload.purification_status.lower(),
            "drain": payload.drain_status.lower(),
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
    except (URLError, TimeoutError, OSError) as error:
        logger.warning("ESP error | house=%s | url=%s | error=%s", house.house_id, url, error)
        return {
            "house_id": house.house_id,
            "esp_ip": ip,
            "esp_url": url,
            "forwarded": False,
            "error": str(error),
        }


def parse_rfid_count(raw_value: str) -> int | None:
    normalized_value = raw_value.strip()

    try:
        count = int(normalized_value)
    except ValueError:
        try:
            parsed_value = json.loads(normalized_value)
        except json.JSONDecodeError:
            parsed_value = None

        if isinstance(parsed_value, dict):
            for key in ("count", "rfid_count", "value"):
                if key in parsed_value:
                    try:
                        count = int(parsed_value[key])
                        break
                    except (TypeError, ValueError):
                        return None
            else:
                match = re.search(r"-?\d+", normalized_value)
                if not match:
                    return None
                count = int(match.group())
        else:
            match = re.search(r"-?\d+", normalized_value)
            if not match:
                return None
            count = int(match.group())

    if count < 0:
        return None

    return count


def record_rfid_recharge(house_id: int, amount: float, raw_value: str) -> None:
    global rfid_event_counter

    with rfid_lock:
        rfid_event_counter += 1
        event = {
            "event_id": rfid_event_counter,
            "house_id": house_id,
            "amount": round(amount, 2),
            "raw_value": raw_value,
            "received_at": utc_now(),
            "source": "rfid",
        }
        rfid_recharge_events.append(event)

    logger.info(
        "RFID recharge queued | house=%s | amount=%.2f | raw=%s",
        house_id,
        amount,
        raw_value,
    )


def reset_rfid_state() -> None:
    global rfid_event_counter

    with rfid_lock:
        rfid_recharge_events.clear()
        last_seen_rfid_counts.clear()
        rfid_event_counter = 0


def build_house_sync_snapshot(house_id: int, consuming: bool | None = None) -> HouseWaterData | None:
    house_data = latest_house_data.get(house_id)
    if not house_data:
        return None

    return HouseWaterData(
        house_id=house_data["house_id"],
        house_name=house_data["house_name"],
        amount_of_water_consumed=house_data["amount_of_water_consumed"],
        wallet_amount_present=house_data["wallet_amount_present"],
        consuming=house_data["consuming"] if consuming is None else consuming,
    )


def poll_house_rfid_counts() -> None:
    while True:
        for house_id, esp_config in ESP_NODES.items():
            ip = esp_config.get("ip", "").strip()
            count_path = esp_config.get("count_path", "/count")

            if not ip:
                continue

            url = build_house_rfid_url(ip, count_path)

            try:
                with urlopen(url, timeout=2) as response:
                    raw_value = response.read().decode("utf-8", errors="replace").strip()
                    print(f"RFID data received | house={house_id} | url={url} | raw={raw_value}", flush=True)
            except URLError as error:
                logger.debug("RFID poll failed | house=%s | url=%s | error=%s", house_id, url, error)
                continue
            except Exception as error:
                logger.debug("RFID poll error | house=%s | url=%s | error=%s", house_id, url, error)
                continue

            current_count = parse_rfid_count(raw_value)
            if current_count is None:
                continue

            with rfid_lock:
                previous_count = last_seen_rfid_counts.get(house_id)

            if previous_count is None:
                with rfid_lock:
                    last_seen_rfid_counts[house_id] = current_count
                logger.info(
                    "RFID baseline captured | house=%s | count=%s | raw=%s",
                    house_id,
                    current_count,
                    raw_value,
                )
                continue

            if current_count < previous_count:
                with rfid_lock:
                    last_seen_rfid_counts[house_id] = current_count
                logger.warning(
                    "RFID counter reset detected | house=%s | previous=%s | current=%s | raw=%s",
                    house_id,
                    previous_count,
                    current_count,
                    raw_value,
                )
                continue

            if current_count == previous_count:
                continue

            if previous_count == 0 and current_count > 0:
                with rfid_lock:
                    last_seen_rfid_counts[house_id] = current_count
                logger.info(
                    "RFID scan edge detected | house=%s | previous=%s | current=%s | raw=%s",
                    house_id,
                    previous_count,
                    current_count,
                    raw_value,
                )
                record_rfid_recharge(house_id, RFID_RECHARGE_AMOUNT, raw_value)
                continue

            increment = current_count - previous_count
            with rfid_lock:
                last_seen_rfid_counts[house_id] = current_count

            for _ in range(increment):
                record_rfid_recharge(house_id, RFID_RECHARGE_AMOUNT, raw_value)

        time.sleep(RFID_POLL_INTERVAL_SECONDS)


def poll_main_tank_level() -> None:
    while True:
        ip = MAIN_TANK_ESP_NODE.get("ip", "").strip()
        path = MAIN_TANK_ESP_NODE.get("path", "/tank")

        if not ip:
            time.sleep(MAIN_TANK_POLL_INTERVAL_SECONDS)
            continue

        url = build_esp_url(ip, path)

        try:
            with urlopen(url, timeout=2) as response:
                raw_value = response.read().decode("utf-8", errors="replace").strip()
        except URLError as error:
            logger.debug("Main tank poll failed | url=%s | error=%s", url, error)
            time.sleep(MAIN_TANK_POLL_INTERVAL_SECONDS)
            continue
        except Exception as error:
            logger.debug("Main tank poll error | url=%s | error=%s", url, error)
            time.sleep(MAIN_TANK_POLL_INTERVAL_SECONDS)
            continue

        current_level = parse_main_tank_level(raw_value)
        if current_level is not None:
            tank_percent, tank_level = convert_main_tank_percent_to_level(current_level)
            latest_main_tank_data.clear()
            latest_main_tank_data.update(
                {
                    "main_tank_percent": tank_percent,
                    "main_tank_level": tank_level,
                    "main_tank_raw": raw_value,
                    "main_tank_received_at": utc_now(),
                    "source": "esp32",
                }
            )

        time.sleep(MAIN_TANK_POLL_INTERVAL_SECONDS)


def poll_purifier_ui_lock() -> None:
    while True:
        ip = PURIFIER_LOCK_ESP_NODE.get("ip", "").strip()
        path = PURIFIER_LOCK_ESP_NODE.get("path", "/purifier")

        if not ip:
            time.sleep(PURIFIER_LOCK_POLL_INTERVAL_SECONDS)
            continue

        url = build_main_tank_url(ip, path)

        try:
            with urlopen(url, timeout=2) as response:
                raw_value = response.read().decode("utf-8", errors="replace").strip()
        except URLError as error:
            logger.debug("Purifier lock poll failed | url=%s | error=%s", url, error)
            time.sleep(PURIFIER_LOCK_POLL_INTERVAL_SECONDS)
            continue
        except Exception as error:
            logger.debug("Purifier lock poll error | url=%s | error=%s", url, error)
            time.sleep(PURIFIER_LOCK_POLL_INTERVAL_SECONDS)
            continue

        lock_state = parse_on_off_state(raw_value)
        if lock_state is not None:
            latest_ui_lock_data.clear()
            latest_ui_lock_data.update(
                {
                    "ui_lock_active": lock_state == "ON",
                    "ui_lock_state": lock_state,
                    "ui_lock_raw": raw_value,
                    "ui_lock_received_at": utc_now(),
                    "source": "esp32",
                }
            )

        time.sleep(PURIFIER_LOCK_POLL_INTERVAL_SECONDS)


def run_startup_drain_timer() -> None:
    """Hold the startup drain active for 15 seconds, then clear it."""
    global startup_drain_active
    time.sleep(STARTUP_DRAIN_DURATION_SECONDS)
    startup_drain_active = False
    logger.info("Startup drain complete — main tank motor now permitted")


def build_shutdown_purification_payload(drain_status: str) -> PurificationSyncRequest:
    return PurificationSyncRequest(
        amount_of_water_purified=max(
            0.0,
            float(latest_purification_data.get("amount_of_water_purified", 0.0) or 0.0),
        ),
        purification_status="OFF",
        drain_status=drain_status,
    )


def sync_shutdown_purification_state(drain_status: str) -> dict[str, Any]:
    payload = build_shutdown_purification_payload(drain_status)
    received_at = utc_now()
    latest_purification_data.update(
        {
            **payload.model_dump(),
            "received_at": received_at,
        }
    )
    logger.warning(
        "SYSTEM SHUTDOWN | purification update | pump=%s | drain=%s",
        payload.purification_status,
        payload.drain_status,
    )
    return send_purification_to_esp(payload)


def set_house_shutdown_state(house_id: int, consuming: bool) -> None:
    action = "on" if consuming else "off"
    plc_result = send_plc_command(f"r{house_id}{action}")

    if plc_result.get("status") == "ok":
        logger.warning(
            "SYSTEM SHUTDOWN | house relay updated | house=%s | action=%s",
            house_id,
            action,
        )
    else:
        logger.warning(
            "SYSTEM SHUTDOWN | house relay update failed | house=%s | action=%s | message=%s",
            house_id,
            action,
            plc_result.get("message", "unknown"),
        )

    if house_id in latest_house_data:
        latest_house_data[house_id]["consuming"] = consuming
        latest_house_data[house_id]["plc_command"] = f"r{house_id}{action}"
        latest_house_data[house_id]["plc_updated_at"] = utc_now()
        house_snapshot = build_house_sync_snapshot(house_id, consuming=consuming)
        if house_snapshot is not None:
            esp_result = send_to_esp(house_snapshot)
            logger.warning(
                "SYSTEM SHUTDOWN | house esp update | house=%s | action=%s | forwarded=%s",
                house_id,
                action,
                esp_result.get("forwarded", False),
            )


def run_shutdown_sequence() -> None:
    global shutdown_sequence_in_progress

    logger.warning(
        "SYSTEM SHUTDOWN | drain phase started | duration_seconds=%s",
        SHUTDOWN_DRAIN_DURATION_SECONDS,
    )

    try:
        sync_shutdown_purification_state("ON")

        for house_id in range(1, 5):
            set_house_shutdown_state(house_id, True)

        time.sleep(SHUTDOWN_DRAIN_DURATION_SECONDS)

        logger.warning("SYSTEM SHUTDOWN | drain phase complete | sending OFF commands")

        for house_id in range(1, 5):
            set_house_shutdown_state(house_id, False)

        sync_shutdown_purification_state("OFF")
        shutdown_raspberry_pi()
    finally:
        shutdown_sequence_in_progress = False


@app.get("/api/startup-drain/status")
def get_startup_drain_status() -> dict[str, Any]:
    """Return whether the startup drain window is still active."""
    elapsed = time.time() - startup_drain_started_at
    remaining = max(0.0, STARTUP_DRAIN_DURATION_SECONDS - elapsed)
    return {
        "status": "ok",
        "startup_drain_active": startup_drain_active,
        "elapsed_seconds": round(elapsed, 2),
        "remaining_seconds": round(remaining, 2),
        "drain_duration_seconds": STARTUP_DRAIN_DURATION_SECONDS,
    }


@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "service": "water-management-esp-bridge"}


@app.post("/api/houses/sync")
def sync_house_data(payload: HouseSyncRequest) -> dict[str, Any]:
    received_at = utc_now()

    logger.info("House sync received | count=%s", len(payload.houses))

    houses_to_forward = []
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

        # Only forward to ESP if relevant fields actually changed
        prev = last_forwarded_house_data.get(house.house_id)
        changed = (
            prev is None or
            prev.get("consuming") != house.consuming or
            prev.get("wallet_amount_present") != house.wallet_amount_present or
            prev.get("amount_of_water_consumed") != house.amount_of_water_consumed
        )
        if changed:
            houses_to_forward.append(house)
            last_forwarded_house_data[house.house_id] = house.model_dump()

    if houses_to_forward:
        with ThreadPoolExecutor(max_workers=len(houses_to_forward)) as executor:
            forwarding_results = list(executor.map(send_to_esp, houses_to_forward))
    else:
        forwarding_results = []

    return {
        "status": "ok",
        "received_at": received_at,
        "houses_received": len(payload.houses),
        "houses_forwarded": len(houses_to_forward),
        "esp_forwarding": forwarding_results,
    }


@app.post("/api/houses/tap")
def open_house_tap(request: TapOpenRequest) -> dict[str, Any]:
    """
    Called when the user opens the tap for a house.
    Deducts TAP_COST_PER_OPEN_RUPEES (₹5) from the wallet and
    increments water consumed by TAP_WATER_PER_OPEN_LITER (1 L).
    Returns an error if the wallet is already at 0.
    """
    received_at = utc_now()
    house_id = request.house_id

    existing = latest_house_data.get(house_id)
    if existing is None:
        return {
            "status": "error",
            "house_id": house_id,
            "message": "House not found — send at least one /api/houses/sync first",
        }

    current_wallet = float(existing.get("wallet_amount_present", 0))

    if current_wallet < TAP_COST_PER_OPEN_RUPEES:
        logger.info(
            "TAP BLOCKED | house=%s | wallet=%.2f | required=%.2f",
            house_id, current_wallet, TAP_COST_PER_OPEN_RUPEES,
        )
        return {
            "status": "blocked",
            "house_id": house_id,
            "message": "Insufficient wallet balance — recharge to open tap",
            "wallet_amount_present": round(current_wallet, 2),
            "required": TAP_COST_PER_OPEN_RUPEES,
        }

    new_wallet = round(max(0.0, current_wallet - TAP_COST_PER_OPEN_RUPEES), 2)
    new_consumed = round(
        float(existing.get("amount_of_water_consumed", 0)) + TAP_WATER_PER_OPEN_LITER, 2
    )
    tap_still_open = new_wallet >= TAP_COST_PER_OPEN_RUPEES  # will next open be possible?

    latest_house_data[house_id].update({
        "wallet_amount_present": new_wallet,
        "amount_of_water_consumed": new_consumed,
        "consuming": True,
        "tap_opened_at": received_at,
    })

    logger.info(
        "TAP OPEN | house=%s | wallet %.2f -> %.2f | consumed +%.1fL = %.2fL | tap_open=%s",
        house_id,
        current_wallet,
        new_wallet,
        TAP_WATER_PER_OPEN_LITER,
        new_consumed,
        tap_still_open,
    )

    house_snapshot = HouseWaterData(
        house_id=house_id,
        house_name=existing.get("house_name", request.house_name or f"House {house_id}"),
        amount_of_water_consumed=new_consumed,
        wallet_amount_present=new_wallet,
        consuming=True,
    )
    esp_result = send_to_esp(house_snapshot)

    return {
        "status": "ok",
        "house_id": house_id,
        "wallet_amount_present": new_wallet,
        "amount_of_water_consumed": new_consumed,
        "water_added_liters": TAP_WATER_PER_OPEN_LITER,
        "cost_deducted": TAP_COST_PER_OPEN_RUPEES,
        "tap_still_open": tap_still_open,
        "received_at": received_at,
        "esp_forwarding": esp_result,
    }


@app.post("/api/purification/sync")
def sync_purification_data(payload: PurificationSyncRequest) -> dict[str, Any]:
    received_at = utc_now()
    latest_purification_data.update(
        {
            **payload.model_dump(),
            "received_at": received_at,
        }
    )

    logger.info(
        "Purification data | purified=%.2f | status=%s | drain=%s",
        payload.amount_of_water_purified,
        payload.purification_status,
        payload.drain_status,
    )

    return {
        "status": "ok",
        "received_at": received_at,
        "esp_forwarding": send_purification_to_esp(payload),
    }


@app.get("/api/purification/esp")
def sync_purification_esp_data(purified: float = 0.0, pump: str = "off") -> dict[str, Any]:
    normalized_pump = pump.strip().lower()
    if normalized_pump not in {"on", "off"}:
        return {
            "status": "error",
            "message": "Invalid pump value",
        }

    received_at = utc_now()
    latest_purification_data["pump_status"] = normalized_pump.upper()
    latest_purification_data["esp_received_at"] = received_at

    logger.info(
        "Purification ESP data received | purified=%.2f | pump=%s",
        round(max(purified, 0.0), 2),
        latest_purification_data["pump_status"],
    )

    return {
        "status": "ok",
        "main_tank_level": latest_main_tank_data.get("main_tank_level"),
        "pump_status": latest_purification_data["pump_status"],
        "received_at": received_at,
    }


@app.get("/api/purification/latest")
def get_latest_purification_data() -> dict[str, Any]:
    purification_payload = {
        **latest_purification_data,
        **latest_main_tank_data,
        **latest_ui_lock_data,
    }

    return {
        "status": "ok",
        "purification": purification_payload,
        "esp_node": PURIFICATION_ESP_NODE,
        "main_tank_esp_node": MAIN_TANK_ESP_NODE,
        "ui_lock_esp_node": PURIFIER_LOCK_ESP_NODE,
    }


@app.get("/api/ui-lock/status")
def get_ui_lock_status() -> dict[str, Any]:
    return {
        "status": "ok",
        "ui_lock": latest_ui_lock_data,
        "esp_node": PURIFIER_LOCK_ESP_NODE,
    }


@app.get("/api/main-tank/latest")
def get_latest_main_tank_data() -> dict[str, Any]:
    return {
        "status": "ok",
        "main_tank": latest_main_tank_data,
        "esp_node": MAIN_TANK_ESP_NODE,
    }


@app.get("/api/houses/latest")
def get_latest_house_data() -> dict[str, Any]:
    return {
        "status": "ok",
        "houses": list(latest_house_data.values()),
        "esp_nodes": ESP_NODES,
    }


@app.get("/api/rfid/recharges")
def get_rfid_recharges(after_event_id: int = 0) -> dict[str, Any]:
    with rfid_lock:
        last_event_id = rfid_event_counter
        effective_after_event_id = after_event_id if after_event_id <= last_event_id else 0
        events = [
            event for event in rfid_recharge_events
            if event["event_id"] > effective_after_event_id
        ]
        counts = dict(last_seen_rfid_counts)

    return {
        "status": "ok",
        "events": events,
        "counts": counts,
        "last_event_id": last_event_id,
        "poll_interval_seconds": RFID_POLL_INTERVAL_SECONDS,
    }


@app.post("/api/plc/control")
def plc_control(request: PlcControlRequest) -> dict[str, Any]:
    """Control PLC relays based on house tap action"""
    mapping = {
        1: ("r1on", "r1off"),
        2: ("r2on", "r2off"),
        3: ("r3on", "r3off"),
        4: ("r4on", "r4off"),
    }

    house_id = request.house_id
    action = request.action

    if house_id not in mapping:
        return {
            "status": "error",
            "house_id": house_id,
            "action": action,
            "message": "Invalid house ID",
        }

    on_cmd, off_cmd = mapping[house_id]
    cmd = on_cmd if action == "on" else off_cmd

    logger.info(
        "PLC REQUEST | house=%s | action=%s | command=%s",
        house_id,
        action,
        cmd,
    )

    result = send_plc_command(cmd)
    result["house_id"] = house_id
    result["action"] = action

    if result.get("status") == "ok":
        logger.info(
            "PLC RESULT | SENT | house=%s | action=%s | command=%s | address=%s | value=%s | attempt=%s",
            house_id,
            action,
            cmd,
            result.get("address"),
            result.get("value"),
            result.get("attempt"),
        )
    else:
        logger.warning(
            "PLC RESULT | NOT_SENT | house=%s | action=%s | command=%s | message=%s | connected=%s",
            house_id,
            action,
            cmd,
            result.get("message", "unknown"),
            result.get("plc_connected"),
        )

    if house_id in latest_house_data:
        latest_house_data[house_id]["consuming"] = action == "on"
        latest_house_data[house_id]["plc_command"] = cmd
        latest_house_data[house_id]["plc_updated_at"] = utc_now()
        house_snapshot = build_house_sync_snapshot(house_id, consuming=action == "on")
        if house_snapshot is not None:
            result["esp_forwarding"] = send_to_esp(house_snapshot)

    return result


@app.post("/api/plc/raw")
def plc_raw_command(request: PlcRawCommandRequest) -> dict[str, Any]:
    """Send a raw PLC command (r1on/r1off/.../ledon/ledoff) — mirrors the CLI script."""
    cmd = request.cmd.lower()
    logger.info("PLC RAW REQUEST | command=%s", cmd)
    return send_plc_command(cmd)


@app.get("/api/plc/status")
def plc_status() -> dict[str, Any]:
    """Get PLC connection status"""
    return {
        "status": "ok" if plc_connected else "error",
        "plc_connected": plc_connected,
        "plc_ip": PLC_HOST,
        "plc_port": PLC_PORT,
        "plc_unit_id": PLC_UNIT_ID,
    }


def shutdown_raspberry_pi() -> None:
    logger.warning("SYSTEM SHUTDOWN | issuing Raspberry Pi shutdown command")
    try:
        subprocess.Popen(["sudo", "shutdown", "-h", "now"])
    except Exception as error:
        logger.error("SYSTEM SHUTDOWN | failed to issue shutdown command | error=%s", error)


@app.post("/api/system/shutdown")
def system_shutdown() -> dict[str, str]:
    global shutdown_sequence_in_progress, shutdown_sequence_started_at

    with shutdown_sequence_lock:
        if shutdown_sequence_in_progress:
            elapsed = max(0.0, time.time() - shutdown_sequence_started_at)
            remaining = max(0.0, SHUTDOWN_DRAIN_DURATION_SECONDS - elapsed)
            logger.warning(
                "SYSTEM SHUTDOWN | duplicate request ignored | remaining_seconds=%.2f",
                remaining,
            )
            return {
                "status": "ok",
                "message": "Shutdown sequence already in progress",
            }

        shutdown_sequence_in_progress = True
        shutdown_sequence_started_at = time.time()
        threading.Thread(
            target=run_shutdown_sequence,
            name="system-shutdown-sequence",
            daemon=True,
        ).start()

    logger.warning(
        "SYSTEM SHUTDOWN | shutdown sequence scheduled | drain_seconds=%s",
        SHUTDOWN_DRAIN_DURATION_SECONDS,
    )
    return {
        "status": "ok",
        "message": "Shutdown drain sequence started",
    }


@app.on_event("startup")
async def startup_event():
    """Connect to PLC on server startup"""
    global startup_drain_active, startup_drain_started_at
    startup_drain_active = False  # No startup delay — motor available immediately
    startup_drain_started_at = time.time()
    logger.info("Server started — no startup drain delay, motor available immediately")
    reset_rfid_state()
    connect_plc()
    threading.Thread(target=poll_house_rfid_counts, name="rfid-poller", daemon=True).start()
    threading.Thread(target=poll_main_tank_level, name="main-tank-poller", daemon=True).start()
    threading.Thread(target=poll_purifier_ui_lock, name="ui-lock-poller", daemon=True).start()
