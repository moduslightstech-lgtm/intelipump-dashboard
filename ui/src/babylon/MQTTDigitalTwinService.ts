import mqtt, { MqttClient } from "mqtt";
import { BabylonSceneManager } from "./BabylonSceneManager";

export interface MqttTwinConfig {
    brokerUrl: string;
    clientId?: string;
    tenantId?: string;
}

export class MQTTDigitalTwinService {
    private client: MqttClient | null = null;
    private sceneManager: BabylonSceneManager;
    private config: MqttTwinConfig;

    constructor(sceneManager: BabylonSceneManager, config: MqttTwinConfig) {
        this.sceneManager = sceneManager;
        this.config = config;
    }

    public connect() {
        const clientId = this.config.clientId || `twin-3d-${Math.random().toString(16).substr(2, 8)}`;
        
        this.client = mqtt.connect(this.config.brokerUrl, {
            clientId,
            clean: true,
            reconnectPeriod: 5000,
        });

        this.client.on("connect", () => {
            console.log("3D Twin MQTT Connected to", this.config.brokerUrl);
            // Subscribe to standard telemetry topics
            this.client?.subscribe("station/pump/+/status");
            this.client?.subscribe("station/pump/+/dispensing");
            this.client?.subscribe("station/tank/+/level");
            // Optionally subscribe to the existing SSE events topic if the backend relays them
            this.client?.subscribe("station/+/events"); 
        });

        this.client.on("message", (topic, message) => {
            this.handleMessage(topic, message.toString());
        });

        this.client.on("error", (err) => {
            console.error("MQTT Error:", err);
        });
    }

    private handleMessage(topic: string, payloadStr: string) {
        try {
            const payload = JSON.parse(payloadStr);

            // Example topic: station/pump/1/dispensing
            if (topic.includes("/pump/") && topic.endsWith("/dispensing")) {
                const parts = topic.split("/");
                const pumpId = parts[2]; // e.g., "1"
                
                // Assuming payload contains { active: boolean }
                const isDispensing = payload.active === true;
                
                // Animate Pump
                this.sceneManager.pumpAnimService.setDispensing(pumpId, isDispensing);
                
                // Link pump to pipe (e.g., pump 1 uses pipe 1, pump 2 uses pipe 2)
                // In a real scenario, this mapping should come from configuration
                const pipeId = pumpId; // naive mapping 1:1
                this.sceneManager.pipeAnimService.setFlowing(pipeId, isDispensing);
            }
            
            // Example topic: station/tank/pms/level
            if (topic.includes("/tank/") && topic.endsWith("/level")) {
                const parts = topic.split("/");
                const tankId = parts[2]; // e.g., "pms", "ago", or "1"
                
                // Assuming payload contains { fillPercent: number }
                if (typeof payload.fillPercent === "number") {
                    this.sceneManager.tankAnimService.updateLevel(tankId, payload.fillPercent);
                }
            }

            // Fallback: handle the legacy TwinAction format if it arrives via MQTT
            if (payload.type === "DISPENSE") {
                const pumpId = payload.payload?.pumpId?.replace(/\D/g, "") || "1";
                this.sceneManager.pumpAnimService.setDispensing(pumpId, true);
                
                const pipeId = payload.payload?.pathPipeIds?.[0] || pumpId;
                this.sceneManager.pipeAnimService.setFlowing(pipeId, true);
            } else if (payload.type === "DISPENSE_STOP") {
                const pumpId = payload.payload?.pumpId?.replace(/\D/g, "") || "1";
                this.sceneManager.pumpAnimService.setDispensing(pumpId, false);
                
                const pipeId = payload.payload?.pathPipeIds?.[0] || pumpId;
                this.sceneManager.pipeAnimService.setFlowing(pipeId, false);
            } else if (payload.type === "TANK_READING") {
                const tankId = payload.payload?.tankId; // e.g. "T1"
                const mappedTankId = tankId === "T1" ? "1" : tankId === "T2" ? "2" : "1";
                const reported = payload.payload?.reported || 0;
                // mock calculation of fill percent based on arbitrary capacity 40k
                const fillPercent = Math.min(100, Math.max(0, (reported / 40000) * 100));
                this.sceneManager.tankAnimService.updateLevel(mappedTankId, fillPercent);
            }

        } catch (err) {
            console.error("Failed to parse or handle MQTT message", err, "Payload:", payloadStr);
        }
    }

    // Optional manual methods for UI testing
    public simulateDispense(pumpId: string, active: boolean) {
        console.log(`Simulation: ${active ? 'Starting' : 'Stopping'} dispense for Pump ${pumpId}`);
        this.sceneManager.pumpAnimService.setDispensing(pumpId, active);
        this.sceneManager.pipeAnimService.setFlowing(pumpId, active); 
        
        // Trigger tank depletion if starting
        if (active) {
            // PMS tank depletion mock: update level every second while active
            // This is a simple simulation for the demo
            this.sceneManager.tankAnimService.updateLevel("pms", 95); // Just a nudge for visual feedback
        }
    }

    public stopAll() {
        console.log("Simulation: Stopping all pumps and animations");
        ["1", "2"].forEach(id => {
            this.sceneManager.pumpAnimService.setDispensing(id, false);
            this.sceneManager.pipeAnimService.setFlowing(id, false);
        });
    }

    public simulateTankLevel(tankId: string, fillPercent: number) {
        console.log(`Simulation: Setting Tank ${tankId} level to ${fillPercent}%`);
        this.sceneManager.tankAnimService.updateLevel(tankId, fillPercent);
    }

    public disconnect() {
        if (this.client) {
            this.client.end();
            this.client = null;
        }
    }
}
