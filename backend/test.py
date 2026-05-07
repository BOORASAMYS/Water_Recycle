from pymodbus.client import ModbusTcpClient
import time

PLC_IP = "192.168.0.10"
PLC_PORT = 502
SLAVE_ID = 0   # 🔥 IMPORTANT (fix)

client = ModbusTcpClient(PLC_IP, port=PLC_PORT, timeout=3)

# -----------------------------
# Connection
# -----------------------------
def connect_plc():
    if client.connect():
        print("✅ Connected to PLC")
        return True
    else:
        print("❌ Failed to connect")
        return False

# -----------------------------
# Write Coil
# -----------------------------
def write_coil(coil, state):
    try:
        result = client.write_coil(coil, state, slave=SLAVE_ID)

        if result.isError():
            print(f"❌ Write failed (coil {coil}) -> {result}")
        else:
            print(f"✅ Coil {coil} set to {state}")

    except Exception as e:
        print("⚠️ Exception:", e)

# -----------------------------
# Read Coils
# -----------------------------
def read_all():
    try:
        result = client.read_coils(0, 5, slave=SLAVE_ID)

        if result.isError():
            print("❌ Read error:", result)
        else:
            print("📊 Status (Relay1→LED):", result.bits[:5])

    except Exception as e:
        print("⚠️ Exception:", e)

# -----------------------------
# Turn OFF all
# -----------------------------
def all_off():
    for i in range(5):
        write_coil(i, False)
        time.sleep(0.2)

# -----------------------------
# Menu Control
# -----------------------------
def menu():
    print("\n--- PLC CONTROL ---")
    print("1 → Relay1 ON")
    print("2 → Relay2 ON")
    print("3 → Relay3 ON")
    print("4 → Relay4 ON")
    print("5 → LED ON")
    print("6 → All OFF")
    print("7 → Read Status")
    print("0 → Exit")

    while True:
        choice = input("\nEnter choice: ")

        if choice == "1":
            write_coil(0, True)

        elif choice == "2":
            write_coil(1, True)

        elif choice == "3":
            write_coil(2, True)

        elif choice == "4":
            write_coil(3, True)

        elif choice == "5":
            write_coil(4, True)

        elif choice == "6":
            all_off()

        elif choice == "7":
            read_all()

        elif choice == "0":
            print("🔌 Disconnecting...")
            break

        else:
            print("❌ Invalid input")

# -----------------------------
# Main
# -----------------------------
if __name__ == "__main__":
    if connect_plc():
        menu()
        client.close()
        print("✅ Disconnected cleanly")