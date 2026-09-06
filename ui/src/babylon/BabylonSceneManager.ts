import { Engine, Scene, ArcRotateCamera, Vector3, HemisphericLight, DirectionalLight, ShadowGenerator, Color4 } from "@babylonjs/core";
import "@babylonjs/loaders/glTF"; // Important for loading .glb files
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { MeshRegistry } from "./MeshRegistry";
import { PumpAnimationService } from "./PumpAnimationService";
import { PipeFlowAnimationService } from "./PipeFlowAnimationService";
import { TankAnimationService } from "./TankAnimationService";
import { TwinAssetGenerator } from "../lib/TwinAssetGenerator";

export type SceneLoadMode = "glb" | "demo";

export class BabylonSceneManager {
    public engine: Engine;
    public scene: Scene;
    public camera: ArcRotateCamera;
    public loadMode: SceneLoadMode = "demo";

    public meshRegistry!: MeshRegistry;
    public pumpAnimService!: PumpAnimationService;
    public pipeAnimService!: PipeFlowAnimationService;
    public tankAnimService!: TankAnimationService;

    constructor(canvas: HTMLCanvasElement) {
        this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
        this.scene = new Scene(this.engine);

        this.scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);

        this.camera = new ArcRotateCamera(
            "camera",
            0.5 * Math.PI,
            1.3,
            40,
            new Vector3(0, 0, 0),
            this.scene
        );
        this.camera.attachControl(canvas, true);
        this.camera.wheelPrecision = 50;
        this.camera.lowerRadiusLimit = 5;
        this.camera.upperRadiusLimit = 100;

        const hemiLight = new HemisphericLight("hemiLight", new Vector3(0, 1, 0), this.scene);
        hemiLight.intensity = 0.5;

        const dirLight = new DirectionalLight("dirLight", new Vector3(-1, -2, -1), this.scene);
        dirLight.position = new Vector3(20, 40, 20);
        dirLight.intensity = 0.8;

        const shadowGenerator = new ShadowGenerator(1024, dirLight);
        shadowGenerator.useBlurExponentialShadowMap = true;
        shadowGenerator.blurKernel = 32;

        this.scene.onNewMeshAddedObservable.add((mesh) => {
            mesh.receiveShadows = true;
            shadowGenerator.addShadowCaster(mesh, true);
        });

        this.engine.runRenderLoop(() => {
            this.scene.render();
        });

        window.addEventListener("resize", this.handleResize);
    }

    public async loadModel(url: string = "/models/fuel_station_v2.glb?v=2.1"): Promise<SceneLoadMode> {
        try {
            console.log("Loading 3D Model from:", url);
            await SceneLoader.AppendAsync("", url, this.scene);
            console.log("GLB Model loaded successfully");
            this.loadMode = "glb";
            this._initServicesAndFrame(true);
            return "glb";
        } catch (error) {
            console.error("Error loading GLB model — falling back to demo station scene", error);
            this.loadDemoScene();
            return "demo";
        }
    }

    public loadDemoScene(): SceneLoadMode {
        TwinAssetGenerator.buildDemoStation(this.scene);
        this.loadMode = "demo";
        this._initServicesAndFrame(false);
        this.camera.setTarget(new Vector3(0, 1, 1));
        this.camera.alpha = -Math.PI / 2.4;
        this.camera.beta = 1.05;
        this.camera.radius = 28;
        this.camera.lowerRadiusLimit = 8;
        this.camera.upperRadiusLimit = 80;
        return "demo";
    }

    private _initServicesAndFrame(frameOnPumps: boolean) {
        this.meshRegistry = new MeshRegistry(this.scene);
        this.pumpAnimService = new PumpAnimationService(this.scene, this.meshRegistry);
        this.pipeAnimService = new PipeFlowAnimationService(this.scene, this.meshRegistry);
        this.tankAnimService = new TankAnimationService(this.scene, this.meshRegistry);
        this.verifyMeshes();

        if (!frameOnPumps) return;

        let min = new Vector3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
        let max = new Vector3(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE);
        let hasPumps = false;

        this.meshRegistry.pumps.forEach((pump) => {
            pump.computeWorldMatrix(true);
            const boundingInfo = pump.getBoundingInfo();
            min = Vector3.Minimize(min, boundingInfo.boundingBox.minimumWorld);
            max = Vector3.Maximize(max, boundingInfo.boundingBox.maximumWorld);
            hasPumps = true;
        });

        if (hasPumps) {
            const center = Vector3.Center(min, max);
            const extent = Vector3.Distance(min, max);
            center.y = 0;
            this.camera.setTarget(center);
            this.camera.alpha = 0.5 * Math.PI;
            this.camera.beta = 1.3;
            this.camera.radius = extent * 1.5;
            this.camera.lowerRadiusLimit = extent * 0.2;
            this.camera.upperRadiusLimit = extent * 15;
            this.camera.wheelPrecision = 100 / extent;
        } else if (this.meshRegistry.station) {
            this.meshRegistry.station.computeWorldMatrix(true);
            this.camera.setTarget(this.meshRegistry.station);
            this.camera.radius = 30;
            this.camera.lowerRadiusLimit = 1;
            this.camera.wheelPrecision = 10;
        } else {
            this.camera.setTarget(Vector3.Zero());
            this.camera.radius = 20;
            this.camera.lowerRadiusLimit = 0.5;
            this.camera.wheelPrecision = 20;
        }
    }

    public verifyMeshes() {
        console.log("--- Detailed Mesh Inventory ---");
        this.scene.meshes.forEach((m) => {
            console.log(`Mesh: "${m.name}" | Parent: "${m.parent?.name || "none"}" | Type: ${m.getClassName()}`);
        });

        const criticalMeshes = ["pump_1", "pump_2", "pipe_1", "pipe_2", "pms", "station"];
        console.log("--- Critical Mesh Verification ---");
        criticalMeshes.forEach((name) => {
            const mesh =
                this.meshRegistry.getPump(name.replace("pump_", "")) ||
                this.meshRegistry.getPipe(name.replace("pipe_", "")) ||
                this.meshRegistry.getTank(name) ||
                (name === "station" ? this.meshRegistry.station : null);

            if (mesh) {
                console.log(`Found critical mesh: ${name} (as ${mesh.name})`);
            } else {
                console.warn(`MISSING critical mesh: ${name}`);
            }
        });
        console.log("--------------------------------");
    }

    public getDiagnostics() {
        const cam = this.camera;
        return {
            meshCount: this.scene.meshes.length,
            loadMode: this.loadMode,
            camera: {
                alpha: cam.alpha,
                beta: cam.beta,
                radius: cam.radius,
                target: [cam.target.x, cam.target.y, cam.target.z],
            },
            canvas: {
                width: this.engine.getRenderWidth(),
                height: this.engine.getRenderHeight(),
            },
        };
    }

    private handleResize = () => {
        this.engine.resize();
    };

    public dispose() {
        window.removeEventListener("resize", this.handleResize);
        this.scene.dispose();
        this.engine.dispose();
    }
}
