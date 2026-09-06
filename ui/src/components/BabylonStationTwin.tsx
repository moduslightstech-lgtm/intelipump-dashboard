import { useEffect, useRef, useState, Component, type ReactNode, type ErrorInfo } from "react";
import { BabylonSceneManager, type SceneLoadMode } from "../babylon/BabylonSceneManager";
import { SimState } from "../types/simulation";

interface BabylonStationTwinProps {
    tenantId?: string;
    stationId?: string;
    sim?: SimState;
    onDispenseStateChange?: (pumpId: string, active: boolean) => void;
    /** Force procedural demo even if GLB exists */
    forceDemo?: boolean;
    onDiagnostics?: (info: Record<string, unknown>) => void;
    className?: string;
}

function webglAvailable(): boolean {
    try {
        const canvas = document.createElement("canvas");
        return !!(
            canvas.getContext("webgl") ||
            canvas.getContext("experimental-webgl") ||
            canvas.getContext("webgl2")
        );
    } catch {
        return false;
    }
}

class TwinErrorBoundary extends Component<
    { children: ReactNode; fallback: ReactNode },
    { error: Error | null }
> {
    state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) {
        return { error };
    }
    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("Digital Twin 3D render error", error, info);
    }
    render() {
        if (this.state.error) return this.props.fallback;
        return this.props.children;
    }
}

export default function BabylonStationTwin({
    tenantId,
    stationId,
    sim,
    forceDemo = false,
    onDiagnostics,
}: BabylonStationTwinProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sceneManagerRef = useRef<BabylonSceneManager | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isReady, setIsReady] = useState(false);
    const [loadMode, setLoadMode] = useState<SceneLoadMode | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hasWebGL, setHasWebGL] = useState(true);

    useEffect(() => {
        if (!canvasRef.current) return;

        if (!webglAvailable()) {
            setHasWebGL(false);
            setIsLoading(false);
            setError("WebGL is not available in this browser.");
            return;
        }
        setHasWebGL(true);

        const manager = new BabylonSceneManager(canvasRef.current);
        sceneManagerRef.current = manager;

        const boot = async () => {
            try {
                let mode: SceneLoadMode;
                if (forceDemo) {
                    mode = manager.loadDemoScene();
                } else {
                    mode = await manager.loadModel("/models/fuel_station_v2.glb?v=2.1");
                }
                setLoadMode(mode);
                setIsReady(true);
                setError(null);
                onDiagnostics?.({
                    webgl: true,
                    sceneMounted: true,
                    ...manager.getDiagnostics(),
                    stationId,
                });
            } catch (err) {
                console.error("Failed to load 3D Twin model", err);
                try {
                    const mode = manager.loadDemoScene();
                    setLoadMode(mode);
                    setIsReady(true);
                    setError(null);
                    onDiagnostics?.({
                        webgl: true,
                        sceneMounted: true,
                        fallback: true,
                        ...manager.getDiagnostics(),
                        stationId,
                    });
                } catch (demoErr) {
                    console.error("Demo scene also failed", demoErr);
                    setError(demoErr instanceof Error ? demoErr.message : "Failed to render 3D scene");
                }
            } finally {
                setIsLoading(false);
            }
        };
        void boot();

        return () => {
            if (sceneManagerRef.current) sceneManagerRef.current.dispose();
            sceneManagerRef.current = null;
            setIsReady(false);
        };
    }, [tenantId, stationId, forceDemo, onDiagnostics]);

    useEffect(() => {
        if (!isReady || !sceneManagerRef.current || !sim) return;
        const manager = sceneManagerRef.current;
        if (!manager.pumpAnimService || !manager.tankAnimService) return;

        try {
            sim.pumps.forEach((p) => {
                const babylonId = p.id === "pump_1" ? "1" : p.id === "pump_2" ? "2" : p.id.replace("pump_", "");
                const isActive = p.status === "DISPENSING";
                manager.pumpAnimService.setDispensing(babylonId, isActive);
                manager.pipeAnimService?.setFlowing?.(babylonId, isActive);
            });
            manager.tankAnimService.updateLevel("pms", sim.tank.percent);
        } catch (e) {
            console.warn("Twin animation sync skipped", e);
        }
    }, [sim, isReady]);

    useEffect(() => {
        if (!isReady || !sceneManagerRef.current || !onDiagnostics) return;
        const id = window.setInterval(() => {
            if (!sceneManagerRef.current) return;
            onDiagnostics({
                webgl: hasWebGL,
                sceneMounted: true,
                ...sceneManagerRef.current.getDiagnostics(),
                stationId,
            });
        }, 2000);
        return () => window.clearInterval(id);
    }, [isReady, onDiagnostics, hasWebGL, stationId]);

    const fallbackUi = (
        <div className="w-full min-h-[600px] flex items-center justify-center bg-slate-950 border border-red-900 rounded-xl text-red-300 text-sm p-6 text-center">
            {error || "3D Digital Twin failed to render."}
            <br />
            <span className="text-slate-500 text-xs mt-2 block">Check WebGL support and that /models/fuel_station_v2.glb is served.</span>
        </div>
    );

    return (
        <TwinErrorBoundary fallback={fallbackUi}>
            <div className="relative w-full min-h-[600px] h-[min(70vh,720px)] rounded-xl overflow-hidden border border-slate-700/50 shadow-2xl bg-[#0d0d14]">
                {isLoading && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-900/80 backdrop-blur-sm">
                        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
                        <p className="text-blue-400 font-medium">Loading Industrial 3D Twin...</p>
                    </div>
                )}

                {!hasWebGL || error ? (
                    fallbackUi
                ) : (
                    <canvas
                        ref={canvasRef}
                        className="w-full h-full outline-none block"
                        style={{ touchAction: "none", width: "100%", height: "100%", minHeight: 600 }}
                    />
                )}

                {loadMode === "demo" && !isLoading && !error && (
                    <div className="absolute top-3 left-3 right-3 z-10 bg-amber-950/90 border border-amber-700 text-amber-100 text-xs px-3 py-2 rounded-lg backdrop-blur-md">
                        Demo layout shown — configure station assets to use live equipment.
                    </div>
                )}

                <div className="absolute bottom-4 right-4 z-10 flex gap-2">
                    <div className="bg-slate-800/80 text-xs text-slate-300 px-3 py-1.5 rounded-full backdrop-blur-md border border-slate-600/50 flex items-center gap-2 shadow-lg">
                        <div className={`w-2 h-2 rounded-full ${isReady ? "bg-green-500 animate-pulse" : "bg-slate-500"}`} />
                        {loadMode === "glb" ? "Live 3D Model" : loadMode === "demo" ? "Demo 3D Scene" : "3D View"}
                    </div>
                </div>
            </div>
        </TwinErrorBoundary>
    );
}
