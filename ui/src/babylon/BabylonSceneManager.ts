import { Engine, Scene, ArcRotateCamera, Vector3, HemisphericLight, DirectionalLight, ShadowGenerator, Color4 } from "@babylonjs/core";
import "@babylonjs/loaders/glTF"; // Important for loading .glb files
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { MeshRegistry } from "./MeshRegistry";
import { PumpAnimationService } from "./PumpAnimationService";
import { PipeFlowAnimationService } from "./PipeFlowAnimationService";
import { TankAnimationService } from "./TankAnimationService";

export class BabylonSceneManager {
    public engine: Engine;
    public scene: Scene;
    public camera: ArcRotateCamera;
    
    public meshRegistry!: MeshRegistry;
    public pumpAnimService!: PumpAnimationService;
    public pipeAnimService!: PipeFlowAnimationService;
    public tankAnimService!: TankAnimationService;

    constructor(canvas: HTMLCanvasElement) {
        this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
        this.scene = new Scene(this.engine);
        
        // Dark background to fit the dashboard theme
        this.scene.clearColor = new Color4(0.05, 0.05, 0.08, 1);

        // Setup Camera: Front-facing industrial view matching target image
        this.camera = new ArcRotateCamera(
            "camera",
            0.5 * Math.PI, // alpha (rotation around Y) - 90 degrees, front face
            1.3, // beta (rotation around X) - look more horizontally to see under canopy
            40, // radius
            new Vector3(0, 0, 0),
            this.scene
        );
        this.camera.attachControl(canvas, true);
        this.camera.wheelPrecision = 50;
        this.camera.lowerRadiusLimit = 5;
        this.camera.upperRadiusLimit = 100;

        // Setup Lighting
        const hemiLight = new HemisphericLight("hemiLight", new Vector3(0, 1, 0), this.scene);
        hemiLight.intensity = 0.5;

        const dirLight = new DirectionalLight("dirLight", new Vector3(-1, -2, -1), this.scene);
        dirLight.position = new Vector3(20, 40, 20);
        dirLight.intensity = 0.8;

        // Setup Shadows
        const shadowGenerator = new ShadowGenerator(1024, dirLight);
        shadowGenerator.useBlurExponentialShadowMap = true;
        shadowGenerator.blurKernel = 32;

        this.scene.onNewMeshAddedObservable.add((mesh) => {
            mesh.receiveShadows = true;
            shadowGenerator.addShadowCaster(mesh, true);
        });

        // Run render loop
        this.engine.runRenderLoop(() => {
            this.scene.render();
        });

        window.addEventListener("resize", this.handleResize);
    }

    public async loadModel(url: string = "/models/fuel_station_v2.glb?v=2.1"): Promise<void> {
        return new Promise((resolve, reject) => {
            console.log("Loading 3D Model from:", url);
            SceneLoader.AppendAsync("", url, this.scene)
                .then(() => {
                    console.log("GLB Model loaded successfully");
                    
                    // Initialize Registry and Services
                    this.meshRegistry = new MeshRegistry(this.scene);
                    this.pumpAnimService = new PumpAnimationService(this.scene, this.meshRegistry);
                    this.pipeAnimService = new PipeFlowAnimationService(this.scene, this.meshRegistry);
                    this.tankAnimService = new TankAnimationService(this.scene, this.meshRegistry);

                    // Verify critical meshes
                    this.verifyMeshes();

                    // Calculate the bounding box of the pumps to frame the central part of the station
                    // This avoids zooming out too far if the model has a massive ground plane
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
                        
                        // Target the center of the pumps but look lower to avoid canopy blocking
                        center.y = 0;
                        this.camera.setTarget(center);

                        // Enforce the front-facing view angles after setting target
                        this.camera.alpha = 0.5 * Math.PI;
                        this.camera.beta = 1.3;

                        // Zoom in to make the station fill the view nicely
                        this.camera.radius = extent * 1.5;  
                        
                        // Set zoom limits
                        this.camera.lowerRadiusLimit = extent * 0.2;
                        this.camera.upperRadiusLimit = extent * 15;
                        
                        // Adjust scroll speed (higher precision = slower zoom)
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

                    resolve();
                })
                .catch((error) => {
                    console.error("Error loading GLB model", error);
                    reject(error);
                });
        });
    }

    public verifyMeshes() {
        console.log("--- Detailed Mesh Inventory ---");
        this.scene.meshes.forEach(m => {
            console.log(`Mesh: "${m.name}" | Parent: "${m.parent?.name || 'none'}" | Type: ${m.getClassName()}`);
        });

        const criticalMeshes = ["pump_1", "pump_2", "pipe_1", "pipe_2", "pms", "station"];
        console.log("--- Critical Mesh Verification ---");
        criticalMeshes.forEach(name => {
            const mesh = this.meshRegistry.getPump(name.replace('pump_', '')) || 
                         this.meshRegistry.getPipe(name.replace('pipe_', '')) || 
                         this.meshRegistry.getTank(name) ||
                         (name === 'station' ? this.meshRegistry.station : null);
            
            if (mesh) {
                console.log(`✅ Found critical mesh: ${name} (as ${mesh.name})`);
            } else {
                console.warn(`❌ MISSING critical mesh: ${name}`);
            }
        });
        console.log("--------------------------------");
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
