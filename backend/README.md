# Water Management ESP Bridge API

This FastAPI backend receives house data from the React frontend and forwards each house's data to a separate ESP node.

## Data Flow

```text
React frontend -> FastAPI /api/houses/sync -> ESP /set route for each house
```

The frontend sends:

- `amount_of_water_consumed`
- `wallet_amount_present`

FastAPI forwards to each ESP using the endpoint expected by your ESP32 sketch:

```text
http://<esp-ip>/set?house=<house_id>&consumed=<amount_of_water_consumed>&price=<wallet_amount_present>
```

For House 1, the configured ESP request is:

```text
http://192.168.0.5/set?house=1&consumed=12.5&price=75
```

The React frontend syncs the latest house values to FastAPI every second. Any UI change to wallet recharge, tap consumption, or reset will be included in the next sync.

The frontend also sends purification data every second:

```json
{
  "amount_of_water_purified": 1240.5,
  "purification_status": "ON"
}
```

FastAPI receives this at:

```text
POST /api/purification/sync
```

If `PURIFICATION_ESP_NODE["ip"]` is filled in `backend/main.py`, FastAPI forwards it as:

```text
http://<esp-ip>/set?purified=<amount_of_water_purified>&status=<ON_OR_OFF>
```

## Setup

```bash
cd backend
py -3.12 -m pip install -r requirements.txt
py -3.12 -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

This uses the global Windows Python launcher instead of PlatformIO, so the backend runs from your system Python install.

From the project root, you can also run:

```bash
py -3.12 -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

API docs:

```text
http://127.0.0.1:8000/docs
```

## ESP Configuration

Edit `ESP_NODES` in `backend/main.py`.

```python
ESP_NODES = {
    1: {"ip": "192.168.0.5", "path": "/set"},
    2: {"ip": "", "path": "/set"},
    3: {"ip": "", "path": "/set"},
    4: {"ip": "", "path": "/set"},
}
```

Keep `ip` blank until you know the ESP board IP address. When blank, FastAPI stores the latest data and skips forwarding for that house.

## Endpoints

- `GET /api/health`
- `POST /api/houses/sync`
- `GET /api/houses/latest`
- `POST /api/purification/sync`
- `GET /api/purification/latest`
