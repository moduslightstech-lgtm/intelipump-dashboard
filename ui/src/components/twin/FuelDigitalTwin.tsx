import React, { useEffect, useRef, useState } from "react";
import { Engine, Scene, ArcRotateCamera, Vector3, HemisphericLight, DefaultRenderingPipeline, Color3, Color4 } from "@babylonjs/core";
import { TwinAssetGenerator } from "../../lib/TwinAssetGenerator";
import { useMqttTwin } from "../../hooks/useMqttTwin";
import { twinAnimations } from "../../lib/twinAnimations";

interface FuelDigitalTwinProps {
    enableDemoMode?: boolean;
    brokerUrl?: string;
    style?: React.CSSProperties;
    className?: string;
}

export const FuelDigitalTwin: React.FC<FuelDigitalTwinProps> = ({ enableDemoMode = true, brokerUrl, style, className }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sceneRef = useRef<Scene | null>(null);
    const { state, pushAction } = useMqttTwin(enableDemoMode, brokerUrl);
    
    // Setup Babylon engine and scene
    useEffect(() => {
        if (!canvasRef.current) return;
        
        const engine = new Engine(canvasRef.current, true, { preserveDrawingBuffer: true, stencil: true });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.06, 0.09, 0.15, 1); // Dark theme matching UI (#0f172a roughly)
        
        // Camera
        const camera = new ArcRotateCamera("Camera", -Math.PI / 2, Math.PI / 3, 25, new Vector3(0, 0, 0), scene);
        camera.attachControl(canvasRef.current, true);
        camera.wheelPrecision = 50;
        camera.lowerRadiusLimit = 10;
        camera.upperRadiusLimit = 50;

        // Lighting
        const light = new HemisphericLight("Light", new Vector3(0, 1, 0), scene);
        light.intensity = 0.8;
        light.groundColor = new Color3(0.1, 0.1, 0.12);

        // Add soft bloom for glow effects
        const pipeline = new DefaultRenderingPipeline("default", true, scene, [camera]);
        pipeline.bloomEnabled = true;
        pipeline.bloomThreshold = 0.6;
        pipeline.bloomWeight = 0.4;

        // --- Build Layout ---
        
        // Center: Tanks
        const tank1 = TwinAssetGenerator.createTank("Tank_T1", scene);
        tank1.position = new Vector3(-2.5, 0, -2);
        
        const tank2 = TwinAssetGenerator.createTank("Tank_T2", scene);
        tank2.position = new Vector3(2.5, 0, -2);
        
        // Left: Pumps
        const pump1 = TwinAssetGenerator.createPump("Pump_P1", scene);
        pump1.position = new Vector3(-8, -1.2, 4);
        const pump2 = TwinAssetGenerator.createPump("Pump_P2", scene);
        pump2.position = new Vector3(-4, -1.2, 4);
        
        // Right: Pumps
        const pump3 = TwinAssetGenerator.createPump("Pump_P3", scene);
        pump3.position = new Vector3(4, -1.2, 4);
        const pump4 = TwinAssetGenerator.createPump("Pump_P4", scene);
        pump4.position = new Vector3(8, -1.2, 4);

        // Pipes (simplified manifold connecting T1/T2 to Pumps)
        const pipe1 = TwinAssetGenerator.createPipeStraight("Pipe_1", scene, 6);
        pipe1.position = new Vector3(-6, -2, 1);
        pipe1.rotation.y = Math.PI / 2; // Horizontal

        const pipe2 = TwinAssetGenerator.createPipeStraight("Pipe_2", scene, 6);
        pipe2.position = new Vector3(0, -2, 1);
        pipe2.rotation.y = Math.PI / 2;

        const pipe3 = TwinAssetGenerator.createPipeStraight("Pipe_3", scene, 6);
        pipe3.position = new Vector3(6, -2, 1);
        pipe3.rotation.y = Math.PI / 2;

        const pipe4 = TwinAssetGenerator.createPipeStraight("Pipe_4", scene, 4);
        pipe4.position = new Vector3(8, -2, 2.5);
        pipe4.rotation.y = 0; // Vertical towards P4

        sceneRef.current = scene;

        engine.runRenderLoop(() => {
            scene.render();
        });

        const handleResize = () => {
            engine.resize();
        };
        window.addEventListener("resize", handleResize);

        return () => {
            window.removeEventListener("resize", handleResize);
            engine.dispose();
        };
    }, []);

    // Sync State -> Babylon Scene
    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;

        // Update Tanks
        Object.values(state.tanks).forEach(tk => {
            twinAnimations.animateTankLevel(scene, tk.id, tk.reported, tk.capacity);
            if (tk.status === "alert") twinAnimations.triggerAlert(scene, tk.id, "error");
        });

        // Update Pumps
        Object.values(state.pumps).forEach(p => {
            twinAnimations.setPumpState(scene, p.id, p.state, p.liveValue);
        });

        // Update Pipes
        Object.values(state.pipes).forEach(p => {
             twinAnimations.setPipeFlow(scene, p.id, p.active);
        });

        // Handle ALERTS
        state.alerts.forEach(al => {
            // Give alert 2 secs of UI time (or handle via timestamp fading in animations)
            const age = Date.now() - al.timestamp;
            if (age < 5000) {
                 twinAnimations.triggerAlert(scene, al.targetId, al.severity === "critical" ? "error" : "warning");
            }
        });

    }, [state]);

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: '400px', ...style }} className={`rounded-xl overflow-hidden shadow-lg ${className}`}>
            <canvas 
               ref={canvasRef} 
               style={{ width: "100%", height: "100%", outline: "none", touchAction: "none" }}
               tabIndex={1}
            />
            {/* HUD Overlay Map for testing dispatch optionally */}
            <div className="absolute top-4 left-4 text-xs font-mono text-white pointer-events-none opacity-70">
                 <h3 className="font-bold text-blue-400 mb-2">LIVE TWIN DATA</h3>
                 <p>T1: {(state.tanks["T1"]?.reported / 1000).toFixed(1)}kL</p>
                 <p>T2: {(state.tanks["T2"]?.reported / 1000).toFixed(1)}kL</p>
            </div>
            {state.alerts.length > 0 && (
                <div className="absolute top-4 right-4 text-xs font-bold text-red-500 bg-red-950/50 px-3 py-1 rounded border border-red-500">
                    {state.alerts[0].message}
                </div>
            )}
        </div>
    );
}

export default FuelDigitalTwin;
