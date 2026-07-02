import { Color3, AbstractMesh, Scene, Animation, PointLight, Vector3, MeshBuilder, StandardMaterial } from "@babylonjs/core";
import { MeshRegistry } from "./MeshRegistry";

export class PumpAnimationService {
    private scene: Scene;
    private registry: MeshRegistry;
    private originalMaterials: Map<number, any> = new Map();
    private activeLights: Map<string, PointLight> = new Map();
    private indicators: Map<string, AbstractMesh> = new Map();

    constructor(scene: Scene, registry: MeshRegistry) {
        this.scene = scene;
        this.registry = registry;
    }

    public setDispensing(pumpId: string, isDispensing: boolean) {
        console.log(`PumpAnimationService: setDispensing called for pump_${pumpId} isDispensing=${isDispensing}`);
        const rootMesh = this.registry.getPump(pumpId);
        if (!rootMesh) return;

        // Manage Indicator Dot (Simple non-emissive dot)
        let indicator = this.indicators.get(pumpId);
        if (!indicator) {
            console.log(`PumpAnimationService: Creating status dot for Pump ${pumpId}`);
            indicator = MeshBuilder.CreateSphere(`PumpIndicator_${pumpId}`, { diameter: 0.5 }, this.scene);
            
            // Position above the pump
            const boundingInfo = rootMesh.getBoundingInfo();
            indicator.position = rootMesh.getAbsolutePosition().clone();
            indicator.position.y += (boundingInfo.boundingBox.maximum.y - boundingInfo.boundingBox.minimum.y) + 0.8;
            
            const mat = new StandardMaterial(`PumpIndicatorMat_${pumpId}`, this.scene);
            mat.diffuseColor = new Color3(0, 0.8, 0.2); // Simple green
            indicator.material = mat;
            
            // Subtle scale pulse
            const pulse = new Animation(`anim_indicator_${pumpId}`, "scaling", 60, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
            pulse.setKeys([
                { frame: 0, value: new Vector3(1, 1, 1) },
                { frame: 30, value: new Vector3(1.2, 1.2, 1.2) },
                { frame: 60, value: new Vector3(1, 1, 1) }
            ]);
            indicator.animations.push(pulse);
            this.scene.beginAnimation(indicator, 0, 60, true);
            
            this.indicators.set(pumpId, indicator);
        }

        if (isDispensing) {
            indicator.isVisible = true;
            
            // Optional subtle scale pulse to the pump body
            if (!this.scene.getAnimatableByTarget(rootMesh)) {
                const scaleAnim = new Animation(`anim_pump_scale_${pumpId}`, "scaling", 60, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
                const baseScale = rootMesh.scaling.clone();
                const targetScale = baseScale.multiplyByFloats(1.01, 1.01, 1.01);
                
                scaleAnim.setKeys([
                    { frame: 0, value: baseScale },
                    { frame: 30, value: targetScale },
                    { frame: 60, value: baseScale }
                ]);
                rootMesh.animations.push(scaleAnim);
                this.scene.beginAnimation(rootMesh, 0, 60, true);
            }
        } else {
            indicator.isVisible = false;
            this.scene.stopAnimation(rootMesh);
        }
    }
}
