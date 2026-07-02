import { Color3, AbstractMesh, Scene, Animation, PointLight, Vector3, MeshBuilder, StandardMaterial } from "@babylonjs/core";
import { MeshRegistry } from "./MeshRegistry";

export class PipeFlowAnimationService {
    private scene: Scene;
    private registry: MeshRegistry;
    private originalMaterials: Map<number, any> = new Map();
    private activeLights: Map<string, PointLight[]> = new Map();
    private flowSpheres: Map<string, AbstractMesh[]> = new Map();

    constructor(scene: Scene, registry: MeshRegistry) {
        this.scene = scene;
        this.registry = registry;
    }

    public setFlowing(pipeId: string, isFlowing: boolean) {
        console.log(`PipeFlowAnimationService: setFlowing called for pipe_${pipeId} isFlowing=${isFlowing}`);
        const rootMesh = this.registry.getPipe(pipeId);
        if (!rootMesh) return;

        if (isFlowing) {
            // Create flow spheres if they don't exist
            if (!this.flowSpheres.has(pipeId)) {
                console.log(`PipeFlowAnimationService: Starting flow particles for Pipe ${pipeId}`);
                const boundingInfo = rootMesh.getBoundingInfo();
                const min = boundingInfo.boundingBox.minimum;
                const max = boundingInfo.boundingBox.maximum;
                const worldMatrix = rootMesh.computeWorldMatrix(true);
                const startPos = Vector3.TransformCoordinates(new Vector3(0, min.y, 0), worldMatrix);
                const endPos = Vector3.TransformCoordinates(new Vector3(0, max.y, 0), worldMatrix);

                const spheres: AbstractMesh[] = [];
                const sphereCount = 3;

                for (let i = 0; i < sphereCount; i++) {
                    const sphere = MeshBuilder.CreateSphere(`flow_sphere_${pipeId}_${i}`, { diameter: 0.35 }, this.scene);
                    const mat = new StandardMaterial(`flow_sphere_mat_${pipeId}_${i}`, this.scene);
                    mat.diffuseColor = new Color3(0, 0.6, 1); // Cyan/Blue
                    sphere.material = mat;
                    sphere.position = startPos.clone();
                    
                    const anim = new Animation(`anim_flow_${pipeId}_${i}`, "position", 60, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
                    anim.setKeys([
                        { frame: 0, value: startPos },
                        { frame: 60, value: endPos }
                    ]);
                    
                    sphere.animations.push(anim);
                    // Offset animations
                    this.scene.beginAnimation(sphere, i * 20, (i * 20) + 60, true);
                    spheres.push(sphere);
                }
                this.flowSpheres.set(pipeId, spheres);
            }
        } else {
            // Remove the flow spheres
            const spheres = this.flowSpheres.get(pipeId);
            if (spheres) {
                spheres.forEach(s => {
                    this.scene.stopAnimation(s);
                    s.dispose();
                });
                this.flowSpheres.delete(pipeId);
            }
        }
    }
}
