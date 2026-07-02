import mqtt from "mqtt";
import { TwinAction } from "./twinState";

export type MqttClientConfig = {
    brokerUrl?: string; // e.g. wss://broker.emqx.io:8084/mqtt
    clientId?: string;
    onMessage: (action: TwinAction) => void;
    enableDemoMode?: boolean;
};

export class TwinMqttClient {
    private client: mqtt.MqttClient | null = null;
    private config: MqttClientConfig;
    private demoIntervals: NodeJS.Timeout[] = [];

    constructor(config: MqttClientConfig) {
        this.config = config;
    }

    public connect() {
        if (this.config.enableDemoMode) {
            this.startDemoMode();
            return;
        }

        if (!this.config.brokerUrl) {
            console.warn("MQTT disconnected: no brokerUrl provided and demoMode is off.");
            return;
        }

        this.client = mqtt.connect(this.config.brokerUrl, {
            clientId: this.config.clientId || `twin-client-${Math.random().toString(16).substr(2, 8)}`
        });

        this.client.on("connect", () => {
            console.log("Connected to MQTT Broker");
            this.client?.subscribe("station/+/events");
        });

        this.client.on("message", (topic, message) => {
            try {
                const payload = JSON.parse(message.toString());
                if (payload.type) {
                    this.config.onMessage(payload as TwinAction);
                }
            } catch (err) {
                console.error("Failed to parse MQTT message", err);
            }
        });
    }

    public disconnect() {
        this.client?.end();
        this.stopDemoMode();
    }

    // --- DEMO SIMULATOR MODE ---
    private startDemoMode() {
        console.log("Starting MQTT Twin Simulator");

        // Simulate frequent tank readings
        let tk1Level = 40000;
        let tk2Level = 30000;

        const readingTimer = setInterval(() => {
            tk1Level -= (Math.random() * 5); // slow leak/drain if dispensing
            tk2Level -= (Math.random() * 2);

            this.config.onMessage({
                type: "TANK_READING",
                payload: { tankId: "T1", reported: tk1Level, expected: tk1Level }
            });
            this.config.onMessage({
                type: "TANK_READING",
                payload: { tankId: "T2", reported: tk2Level, expected: tk2Level }
            });
        }, 5000);

        // Simulate a dispense event sporadically
        const dispenseTimer = setInterval(() => {
            const isP3 = Math.random() > 0.5;
            const pumpId = isP3 ? "P3" : "P4";
            
            // Dispatch dispense START
            this.config.onMessage({
                type: "DISPENSE",
                payload: {
                    tankId: "T1", // Pulling from PMS T1
                    pumpId,
                    amount: 58,
                    pathPipeIds: isP3 ? ["1", "3"] : ["1", "4"] // Paths derived from layout
                }
            });

            // Dispatch dispense STOP after 5s
            setTimeout(() => {
                this.config.onMessage({
                    type: "DISPENSE_STOP",
                    payload: { pumpId, pathPipeIds: isP3 ? ["1", "3"] : ["1", "4"] }
                });
            }, 5000 + Math.random() * 3000); // 5-8 second dispense
        }, 15000); // Every 15 seconds

        // Simulate sporadic alert
        const alertTimer = setInterval(() => {
            if (Math.random() > 0.8) {
                this.config.onMessage({
                    type: "ALERT",
                    payload: { targetId: "P2", severity: "warning", message: "Pump offline" }
                });
                // clear after 6 sec
                setTimeout(() => this.config.onMessage({ type: "CLEAR_ALERTS" }), 6000);
            }
        }, 25000);

        this.demoIntervals.push(readingTimer, dispenseTimer, alertTimer);
    }

    private stopDemoMode() {
        this.demoIntervals.forEach(clearInterval);
        this.demoIntervals = [];
    }
}
