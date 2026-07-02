import { AbstractMesh, Scene, Animation, Space, Vector3, MeshBuilder, StandardMaterial, Color3 } from "@babylonjs/core";
import { MeshRegistry } from "./MeshRegistry";

export class TankAnimationService {
    private scene: Scene;
    private registry: MeshRegistry;
    private fuelMeshes: Map<string, AbstractMesh> = new Map();
    private tankInitialScales: Map<string, number> = new Map();

    constructor(scene: Scene, registry: MeshRegistry) {
        this.scene = scene;
        this.registry = registry;
    }

    public updateLevel(tankId: string, fillPercent: number) {
        console.log(`TankAnimationService: updateLevel(${tankId}, ${fillPercent}%)`);
        
        let fuelMesh = this.fuelMeshes.get(tankId);
        
        if (!fuelMesh) {
            // Try to find an existing fuel mesh in the GLB (e.g., Fuel_PMS or fuel_pms)
            const shellMesh = this.registry.getTank(tankId);
            if (!shellMesh) {
                console.warn(`Tank shell ${tankId} not found in registry`);
                return;
            }

            // Look for children or named mesh
            fuelMesh = this.scene.getMeshByName(`Fuel_${shellMesh.name}`) || 
                       this.scene.getMeshByName(`fuel_${shellMesh.name.toLowerCase()}`) ||
                       shellMesh.getChildMeshes().find(m => m.name.toLowerCase().includes("fuel")) as AbstractMesh;

            if (!fuelMesh) {
                console.log(`TankAnimationService: No fuel mesh found for ${tankId}, creating runtime cylinder`);
                const boundingInfo = shellMesh.getBoundingInfo();
                const height = (boundingInfo.boundingBox.maximum.y - boundingInfo.boundingBox.minimum.y) * 0.95;
                const diameter = Math.min(boundingInfo.boundingBox.maximum.x - boundingInfo.boundingBox.minimum.x, boundingInfo.boundingBox.maximum.z - boundingInfo.boundingBox.minimum.z) * 0.85;
                
                fuelMesh = MeshBuilder.CreateCylinder(`Fuel_${tankId}_Runtime`, {
                    height: height,
                    diameter: diameter,
                    tessellation: 16
                }, this.scene);
                
                // Position at the center of the shell
                fuelMesh.position = shellMesh.getAbsolutePosition().clone();
                fuelMesh.position.y += height * 0.05; // slight offset from bottom

                const fuelMat = new StandardMaterial(`FuelMat_${tankId}`, this.scene);
                fuelMat.diffuseColor = new Color3(1, 0.1, 0.1); // Reddish
                fuelMat.alpha = 0.6; // Semi-transparent
                fuelMesh.material = fuelMat;
                
                // Ensure it receives shadows and is part of the scene properly
                fuelMesh.receiveShadows = true;
            }
            
            this.fuelMeshes.set(tankId, fuelMesh);
            
            // Set pivot to bottom
            const boundingInfo = fuelMesh.getBoundingInfo();
            const bottomPoint = new Vector3(0, - (boundingInfo.boundingBox.maximum.y - boundingInfo.boundingBox.minimum.y) / 2, 0);
            fuelMesh.setPivotPoint(bottomPoint, Space.LOCAL);
            this.tankInitialScales.set(fuelMesh.uniqueId.toString(), fuelMesh.scaling.y);
        }

        const initialScaleY = this.tankInitialScales.get(fuelMesh.uniqueId.toString()) || 1;
        const targetScaleY = initialScaleY * (Math.max(0.01, fillPercent / 100));
        
        console.log(`TankAnimationService: Animating ${fuelMesh.name} to level ${fillPercent}%`);
        this.animateTankScale(fuelMesh, targetScaleY);
    }

    private animateTankScale(mesh: AbstractMesh, targetScaleY: number) {
        // Stop previous animation if any
        this.scene.stopAnimation(mesh, "scaling.y");

        const animation = new Animation(
            `tankScaleAnim_${mesh.name}`,
            "scaling.y",
            60,
            Animation.ANIMATIONTYPE_FLOAT,
            Animation.ANIMATIONLOOPMODE_CONSTANT
        );

        const keys = [
            { frame: 0, value: mesh.scaling.y },
            { frame: 60, value: targetScaleY }
        ];

        animation.setKeys(keys);
        mesh.animations = mesh.animations || [];
        mesh.animations.push(animation);
        this.scene.beginAnimation(mesh, 0, 60, false);
    }
}
