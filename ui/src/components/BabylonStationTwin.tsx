import React, { useEffect, useRef, useState } from "react";
import { BabylonSceneManager } from "../babylon/BabylonSceneManager";
import { MQTTDigitalTwinService } from "../babylon/MQTTDigitalTwinService";
import { SimState } from "../types/simulation";

interface BabylonStationTwinProps {
    tenantId?: string;
    stationId?: string;
    sim?: SimState; // New prop for centralized simulation state
    onDispenseStateChange?: (pumpId: string, active: boolean) => void;
}

export default function BabylonStationTwin({ tenantId, stationId, sim, onDispenseStateChange }: BabylonStationTwinProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sceneManagerRef = useRef<BabylonSceneManager | null>(null);
    const mqttServiceRef = useRef<MQTTDigitalTwinService | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isReady, setIsReady] = useState(false); // Track if services are initialized

    useEffect(() => {
        if (!canvasRef.current) return;

        // Initialize Scene Manager
        const manager = new BabylonSceneManager(canvasRef.current);
        sceneManagerRef.current = manager;

        manager.loadModel("/models/fuel_station_v2.glb?v=2.1")
            .then(() => {
                setIsLoading(false);

                // Initialize MQTT Service as command bridge
                const mqttService = new MQTTDigitalTwinService(manager, {
                    brokerUrl: "wss://broker.emqx.io:8084/mqtt",
                    tenantId
                });
                
                mqttService.connect();
                mqttServiceRef.current = mqttService;
                setIsReady(true);
            })
            .catch((err) => {
                console.error("Failed to load 3D Twin", err);
                setIsLoading(false);
            });

        return () => {
            if (mqttServiceRef.current) mqttServiceRef.current.disconnect();
            if (sceneManagerRef.current) sceneManagerRef.current.dispose();
            setIsReady(false);
        };
    }, [tenantId, stationId]);

    // Update animations based on simulation state
    useEffect(() => {
        if (!isReady || !sceneManagerRef.current || !sim) return;

        const manager = sceneManagerRef.current;
        
        console.log("BabylonStationTwin: Sim received", {
            tankPercent: sim.tank.percent,
            activePumps: sim.pumps.filter(p => p.status === 'DISPENSING').map(p => p.id)
        });

        // Update pumps and pipes directly
        sim.pumps.forEach(p => {
            const babylonId = p.id === 'pump_1' ? '1' : '2';
            const isActive = p.status === 'DISPENSING';
            
            console.log(`BabylonStationTwin: Calling pump animation for ${p.id} active=${isActive}`);
            manager.pumpAnimService.setDispensing(babylonId, isActive);
            
            console.log(`BabylonStationTwin: Calling pipe animation for pipe_${babylonId} active=${isActive}`);
            manager.pipeAnimService.setFlowing(babylonId, isActive);
        });

        // Update tank level directly
        console.log(`BabylonStationTwin: Calling tank animation for pms level=${sim.tank.percent}%`);
        manager.tankAnimService.updateLevel('pms', sim.tank.percent);

    }, [sim, isReady]);

    return (
        <div className="relative w-full h-[500px] rounded-xl overflow-hidden border border-slate-700/50 shadow-2xl bg-[#0d0d14]">
            {isLoading && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-900/80 backdrop-blur-sm">
                    <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
                    <p className="text-blue-400 font-medium">Loading Industrial 3D Twin...</p>
                </div>
            )}
            
            <canvas 
                ref={canvasRef} 
                className="w-full h-full outline-none" 
                style={{ touchAction: "none" }}
            />
            
            <div className="absolute bottom-4 right-4 z-10 flex gap-2">
                <div className="bg-slate-800/80 text-xs text-slate-300 px-3 py-1.5 rounded-full backdrop-blur-md border border-slate-600/50 flex items-center gap-2 shadow-lg">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    Live 3D View
                </div>
            </div>
            
            <div className="absolute top-4 left-4 z-10 pointer-events-none">
                <h3 className="text-lg font-bold text-white tracking-wide drop-shadow-md">Station Overview</h3>
                <p className="text-xs text-slate-300 drop-shadow-sm">Interactive Isometric Camera</p>
            </div>
        </div>
    );
}
