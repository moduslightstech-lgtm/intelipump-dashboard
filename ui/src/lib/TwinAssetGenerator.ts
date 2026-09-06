import {
    Scene,
    MeshBuilder,
    Vector3,
    StandardMaterial,
    Color3,
    Mesh,
    TransformNode,
    Texture,
    Matrix
} from "@babylonjs/core";

export class TwinAssetGenerator {
    /**
     * Creates a reusable tank model
     */
    static createTank(name: string, scene: Scene): TransformNode {
        const root = new TransformNode(`${name}Root`, scene);

        // Materials
        const shellMat = new StandardMaterial(`${name}ShellMat`, scene);
        shellMat.diffuseColor = new Color3(0.1, 0.1, 0.12);
        shellMat.specularColor = new Color3(0.2, 0.2, 0.2);

        const fuelMat = new StandardMaterial(`${name}FuelMat`, scene);
        fuelMat.diffuseColor = new Color3(0.2, 0.6, 1.0); // Default blue for PMS
        fuelMat.alpha = 0.8;
        fuelMat.backFaceCulling = false;

        const surfaceMat = new StandardMaterial(`${name}SurfaceMat`, scene);
        surfaceMat.diffuseColor = new Color3(0.4, 0.8, 1.0);
        surfaceMat.emissiveColor = new Color3(0.1, 0.2, 0.3);

        const glowMat = new StandardMaterial(`${name}GlowMat`, scene);
        glowMat.emissiveColor = new Color3(0, 0, 0); // Black = off
        glowMat.alpha = 0.5;

        // Geometries
        // TankBody: slightly rounded rectangular tank
        const body = MeshBuilder.CreateBox("TankBody", { width: 4, height: 6, depth: 3 }, scene);
        body.material = shellMat;
        body.parent = root;

        // FuelVolume: inner mesh that scales on Y
        const fuelVolume = MeshBuilder.CreateBox("FuelVolume", { width: 3.8, height: 5.8, depth: 2.8 }, scene);
        fuelVolume.material = fuelMat;
        fuelVolume.parent = root;
        // Shift pivot to bottom so it scales up from the bottom
        fuelVolume.setPivotMatrix(Matrix.Translation(0, -2.9, 0), false);
        fuelVolume.position.y = -2.9;
        fuelVolume.scaling.y = 0.5; // 50% full initially

        // FuelSurface: moves with fuel level
        const surface = MeshBuilder.CreatePlane("FuelSurface", { width: 3.8, height: 2.8 }, scene);
        surface.rotation.x = Math.PI / 2;
        surface.material = surfaceMat;
        surface.parent = root;
        surface.position.y = 0; // Will be animated

        // TankBorderGlow: outer subtle frame for alerts
        const border = MeshBuilder.CreateBox("TankBorderGlow", { width: 4.2, height: 6.2, depth: 3.2 }, scene);
        border.material = glowMat;
        border.parent = root;
        border.isPickable = false;

        // Ensure proper naming mapping mapping
        root.name = name; // e.g. "Tank_T1"
        fuelVolume.name = `Fuel_${name.split('_')[1]}`; // e.g. "Fuel_T1"
        surface.name = `Surface_${name.split('_')[1]}`;
        border.name = `TankGlow_${name.split('_')[1]}`;

        return root;
    }

    /**
     * Creates a reusable pump model
     */
    static createPump(name: string, scene: Scene): TransformNode {
        const root = new TransformNode(`${name}Root`, scene);

        // Materials
        const bodyMat = new StandardMaterial(`${name}BodyMat`, scene);
        bodyMat.diffuseColor = new Color3(0.15, 0.15, 0.18);

        const panelMat = new StandardMaterial(`${name}PanelMat`, scene);
        panelMat.diffuseColor = new Color3(0.05, 0.05, 0.05);

        const indicatorMat = new StandardMaterial(`${name}IndicatorMat`, scene);
        indicatorMat.emissiveColor = new Color3(0.5, 0.5, 0.5); // Default grey (idle)

        const glowMat = new StandardMaterial(`${name}GlowMat`, scene);
        glowMat.emissiveColor = new Color3(0, 0, 0); // Off

        const screenMat = new StandardMaterial(`${name}ScreenMat`, scene);
        screenMat.diffuseColor = new Color3(0, 0, 0);
        screenMat.emissiveColor = new Color3(0, 0.5, 0);

        // Geometries
        const body = MeshBuilder.CreateBox("PumpBody", { width: 1.5, height: 3.5, depth: 1 }, scene);
        body.material = bodyMat;
        body.parent = root;

        const panel = MeshBuilder.CreateBox("PumpPanel", { width: 1.2, height: 1.5, depth: 0.1 }, scene);
        panel.material = panelMat;
        panel.position.set(0, 0.5, -0.5);
        panel.parent = root;

        // Screen area
        const screen = MeshBuilder.CreatePlane("PumpValueScreen", { width: 1.0, height: 0.4 }, scene);
        screen.material = screenMat;
        screen.position.set(0, 0.8, -0.56);
        screen.parent = root;

        // Indicator Light (top)
        const indicator = MeshBuilder.CreateSphere("PumpIndicatorLight", { diameter: 0.3 }, scene);
        indicator.material = indicatorMat;
        indicator.position.set(0, 1.8, 0);
        indicator.parent = root;

        // Glow Frame
        const glowFrame = MeshBuilder.CreateBox("PumpGlowFrame", { width: 1.6, height: 3.6, depth: 1.1 }, scene);
        glowFrame.material = glowMat;
        glowFrame.parent = root;
        glowFrame.isPickable = false;

        // Map names
        root.name = name; // "Pump_P1"
        indicator.name = `PumpIndicator_${name.split('_')[1]}`;
        glowFrame.name = `PumpGlow_${name.split('_')[1]}`;
        screen.name = `PumpScreen_${name.split('_')[1]}`;

        return root;
    }

    /**
     * Creates a reusable straight pipe model
     */
    static createPipeStraight(name: string, scene: Scene, length: number = 4): TransformNode {
        const root = new TransformNode(`${name}Root`, scene);

        const pipeMat = new StandardMaterial(`${name}PipeMat`, scene);
        pipeMat.diffuseColor = new Color3(0.3, 0.3, 0.3);
        pipeMat.alpha = 0.5;

        const flowMat = new StandardMaterial(`${name}FlowMat`, scene);
        flowMat.emissiveColor = new Color3(0, 0.6, 1.0); // Active color
        flowMat.disableLighting = true;

        const glowMat = new StandardMaterial(`${name}GlowMat`, scene);
        glowMat.emissiveColor = new Color3(0, 0, 0); // Off

        const body = MeshBuilder.CreateCylinder("PipeBody", { height: length, diameter: 0.4 }, scene);
        body.material = pipeMat;
        body.rotation.x = Math.PI / 2; // Flat on Z axis
        body.parent = root;

        const flowCore = MeshBuilder.CreateCylinder("PipeFlowCore", { height: length - 0.1, diameter: 0.2 }, scene);
        flowCore.material = flowMat;
        flowCore.rotation.x = Math.PI / 2;
        flowCore.parent = root;
        flowCore.visibility = 0; // hidden until active

        const glow = MeshBuilder.CreateCylinder("PipeGlow", { height: length + 0.1, diameter: 0.6 }, scene);
        glow.material = glowMat;
        glow.rotation.x = Math.PI / 2;
        glow.parent = root;
        glow.visibility = 0;

        root.name = name;
        flowCore.name = `PipeFlow_${name.split('_')[1]}`;
        glow.name = `PipeGlow_${name.split('_')[1]}`;

        return root;
    }

    /** Full fallback petrol-station environment (no GLB required). */
    static buildDemoStation(scene: Scene): void {
        const asphalt = new StandardMaterial("demoAsphalt", scene);
        asphalt.diffuseColor = new Color3(0.12, 0.13, 0.15);
        const ground = MeshBuilder.CreateGround("Forecourt", { width: 40, height: 28 }, scene);
        ground.material = asphalt;
        ground.receiveShadows = true;

        const roadMat = new StandardMaterial("demoRoad", scene);
        roadMat.diffuseColor = new Color3(0.18, 0.18, 0.2);
        const road = MeshBuilder.CreateGround("Road", { width: 40, height: 6 }, scene);
        road.position.z = 12;
        road.material = roadMat;

        const markMat = new StandardMaterial("demoMark", scene);
        markMat.emissiveColor = new Color3(0.9, 0.75, 0.2);
        markMat.disableLighting = true;
        const entrance = MeshBuilder.CreateGround("Entrance", { width: 4, height: 1.2 }, scene);
        entrance.position.set(-8, 0.02, 12);
        entrance.material = markMat;
        const exit = MeshBuilder.CreateGround("Exit", { width: 4, height: 1.2 }, scene);
        exit.position.set(8, 0.02, 12);
        exit.material = markMat;

        const canopyMat = new StandardMaterial("demoCanopy", scene);
        canopyMat.diffuseColor = new Color3(0.75, 0.15, 0.12);
        const canopy = MeshBuilder.CreateBox("Canopy", { width: 22, height: 0.4, depth: 10 }, scene);
        canopy.position.set(0, 5.2, 2);
        canopy.material = canopyMat;

        const pillarMat = new StandardMaterial("demoPillar", scene);
        pillarMat.diffuseColor = new Color3(0.7, 0.7, 0.72);
        for (const [x, z] of [
            [-9, -1],
            [9, -1],
            [-9, 5],
            [9, 5],
        ] as const) {
            const p = MeshBuilder.CreateCylinder(`Pillar_${x}_${z}`, { height: 5, diameter: 0.45 }, scene);
            p.position.set(x, 2.5, z);
            p.material = pillarMat;
        }

        const officeMat = new StandardMaterial("demoOffice", scene);
        officeMat.diffuseColor = new Color3(0.22, 0.28, 0.35);
        const office = MeshBuilder.CreateBox("Office", { width: 8, height: 4, depth: 5 }, scene);
        office.position.set(0, 2, -9);
        office.material = officeMat;

        const windowMat = new StandardMaterial("demoWindow", scene);
        windowMat.emissiveColor = new Color3(0.4, 0.7, 0.95);
        windowMat.disableLighting = true;
        const win = MeshBuilder.CreatePlane("OfficeWindow", { width: 3, height: 1.4 }, scene);
        win.position.set(0, 2.2, -6.45);
        win.material = windowMat;

        const gwMat = new StandardMaterial("demoGateway", scene);
        gwMat.diffuseColor = new Color3(0.1, 0.12, 0.14);
        gwMat.emissiveColor = new Color3(0.05, 0.25, 0.1);
        const gateway = MeshBuilder.CreateBox("Gateway", { width: 0.8, height: 1.6, depth: 0.5 }, scene);
        gateway.position.set(5.5, 0.8, -7);
        gateway.material = gwMat;
        const ant = MeshBuilder.CreateCylinder("GatewayAntenna", { height: 1.2, diameter: 0.08 }, scene);
        ant.position.set(5.5, 2.2, -7);
        ant.material = pillarMat;

        const tank1 = TwinAssetGenerator.createTank("Tank_T1", scene);
        tank1.position = new Vector3(-6, 0, -4);
        tank1.scaling = new Vector3(0.45, 0.45, 0.45);
        const tank2 = TwinAssetGenerator.createTank("Tank_T2", scene);
        tank2.position = new Vector3(6, 0, -4);
        tank2.scaling = new Vector3(0.45, 0.45, 0.45);

        const positions = [
            [-7.5, 3],
            [-2.5, 3],
            [2.5, 3],
            [7.5, 3],
        ] as const;
        positions.forEach(([x, z], i) => {
            const pump = TwinAssetGenerator.createPump(`Pump_P${i + 1}`, scene);
            pump.position = new Vector3(x, 0, z);
            // Alias names MeshRegistry / GLB animations expect
            const alias = MeshBuilder.CreateBox(`pump_${i + 1}`, { width: 0.01, height: 0.01, depth: 0.01 }, scene);
            alias.isVisible = false;
            alias.parent = pump;
        });
    }
}
