import { AbstractMesh, Scene } from "@babylonjs/core";

export class MeshRegistry {
    public pumps: Map<string, AbstractMesh> = new Map();
    public pipes: Map<string, AbstractMesh> = new Map();
    public tanks: Map<string, AbstractMesh> = new Map();
    public station: AbstractMesh | null = null;

    constructor(scene: Scene) {
        // Collect all meshes from the scene that match our known patterns
        scene.meshes.forEach((mesh) => {
            const name = mesh.name.toLowerCase();
            console.log(`MeshRegistry: Scanning mesh "${mesh.name}"`);

            if (name.startsWith("pump_")) {
                console.log(`MeshRegistry: Found Pump: ${mesh.name}`);
                this.pumps.set(name, mesh);
            } else if (name.startsWith("pipe_")) {
                console.log(`MeshRegistry: Found Pipe: ${mesh.name}`);
                this.pipes.set(name, mesh);
            } else if (name === "pms" || name.startsWith("pms_") || name.startsWith("ago_")) {
                console.log(`MeshRegistry: Found Tank: ${mesh.name}`);
                this.tanks.set(name, mesh);
            } else if (name === "station") {
                console.log(`MeshRegistry: Found Station: ${mesh.name}`);
                this.station = mesh;
            }
        });

        console.log("MeshRegistry initialized", {
            pumps: Array.from(this.pumps.keys()),
            pipes: Array.from(this.pipes.keys()),
            tanks: Array.from(this.tanks.keys()),
            stationFound: !!this.station
        });
    }

    public getPump(id: string): AbstractMesh | undefined {
        return this.pumps.get(`pump_${id}`);
    }

    public getPipe(id: string): AbstractMesh | undefined {
        return this.pipes.get(`pipe_${id}`);
    }

    public getTank(id: string): AbstractMesh | undefined {
        return this.tanks.get(id) || this.tanks.get(`pms_${id}`) || this.tanks.get(`ago_${id}`);
    }
}
