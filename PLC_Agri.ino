#include <Ethernet.h>
#include <ArduinoModbus.h>

// ======================================
// NETWORK CONFIG
// ======================================

byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xED };

IPAddress ip(192, 168, 1, 2);
IPAddress dns(192, 168, 1, 1);
IPAddress gateway(192, 168, 1, 1);
IPAddress subnet(255, 255, 255, 0);

// ======================================
// MODBUS SERVER
// ======================================

EthernetServer ethServer(502);
ModbusTCPServer modbus;

EthernetClient client;

// ======================================
// RELAY PINS
// ======================================

#define RELAY1 D0
#define RELAY2 D1
#define RELAY3 D2
#define RELAY4 D3

#define LED_PIN LED_D0

// ======================================
// RELAY CONTROL
// ======================================

// TRUE  -> ON
// FALSE -> OFF

void relayWrite(uint8_t pin, bool state) {

  if (state) {
    digitalWrite(pin, HIGH);   // ON
  } else {
    digitalWrite(pin, LOW);    // OFF
  }
}

// ======================================
// SAFE START
// ======================================

void stopAllRelays() {

  relayWrite(RELAY1, false);
  relayWrite(RELAY2, false);
  relayWrite(RELAY3, false);
  relayWrite(RELAY4, false);

  digitalWrite(LED_PIN, LOW);
}

// ======================================
// SETUP
// ======================================

void setup() {

  Serial.begin(115200);

  // OUTPUTS
  pinMode(RELAY1, OUTPUT);
  pinMode(RELAY2, OUTPUT);
  pinMode(RELAY3, OUTPUT);
  pinMode(RELAY4, OUTPUT);

  pinMode(LED_PIN, OUTPUT);

  // SAFE OFF AT STARTUP
  stopAllRelays();

  // START ETHERNET
  Ethernet.begin(mac, ip, dns, gateway, subnet);

  delay(1000);

  Serial.print("PLC IP Address: ");
  Serial.println(Ethernet.localIP());

  // START ETHERNET SERVER
  ethServer.begin();

  // START MODBUS TCP SERVER
  if (!modbus.begin()) {

    Serial.println("Failed to Start Modbus TCP Server");

    while (1);
  }

  // CREATE 5 COILS
  // Coil 0 -> Relay1
  // Coil 1 -> Relay2
  // Coil 2 -> Relay3
  // Coil 3 -> Relay4
  // Coil 4 -> LED

  modbus.configureCoils(0, 5);

  // INITIAL COIL STATE = OFF
  for (int i = 0; i < 5; i++) {
    modbus.coilWrite(i, false);
  }

  Serial.println("Modbus TCP Server Ready");
}

// ======================================
// LOOP
// ======================================

void loop() {

  // ======================================
  // ACCEPT CLIENT CONNECTION
  // ======================================

  EthernetClient newClient = ethServer.available();

  if (newClient) {

    // CLOSE OLD CLIENT
    if (client) {
      client.stop();
    }

    client = newClient;

    modbus.accept(client);

    Serial.println("Client Connected");
  }

  // ======================================
  // HANDLE MODBUS REQUESTS
  // ======================================

  if (client.connected()) {

    modbus.poll();

    // UPDATE OUTPUTS ONLY
    // AFTER MODBUS COMMANDS

    relayWrite(RELAY1, modbus.coilRead(0));
    relayWrite(RELAY2, modbus.coilRead(1));
    relayWrite(RELAY3, modbus.coilRead(2));
    relayWrite(RELAY4, modbus.coilRead(3));

    digitalWrite(LED_PIN, modbus.coilRead(4));
  }

  // ======================================
  // CLIENT DISCONNECTED
  // ======================================

  else {

    stopAllRelays();
  }

  delay(1);
}