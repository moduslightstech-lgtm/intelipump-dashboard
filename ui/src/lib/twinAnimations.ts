import { Scene, Mesh, StandardMaterial, Color3, Matrix, Animation, BezierCurveEase, EasingFunction } from "@babylonjs/core";

export const twinAnimations = {
    animateTankLevel: (scene: Scene, tankId: string, liters: number, capacity: number) => {
        const fuelVol = scene.getMeshByName(`Fuel_${tankId}`) as Mesh;
        const surface = scene.getMeshByName(`Surface_${tankId}`) as Mesh;
        if (!fuelVol || !surface) return;

        const maxScaleY = 5.8; // Internal height based on AssetGenerator
        const fillRatio = Math.max(0.01, Math.min(1, liters / capacity));
        const targetScaleY = fillRatio; // since we modeled it with scaling 1 = max, but oh wait, wait.. fuelVolume is 5.8 

        // Let's create an animation for scaling.y of fuel
        const anim = new Animation("fuelAnim", "scaling.y", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
        const keys = [
            { frame: 0, value: fuelVol.scaling.y },
            { frame: 30, value: fillRatio }
        ];
        anim.setKeys(keys);
        
        // Easing
        const ease = new BezierCurveEase(0.32, 0, 0.67, 0);
        ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
        anim.setEasingFunction(ease);

        fuelVol.animations = [anim];
        scene.beginAnimation(fuelVol, 0, 30, false);
        
        // Surface needs to move proportionally up. Base Y: -2.9 to 2.9 (5.8 height total).
        const targetPosY = -2.9 + (fillRatio * 5.8);
        const animY = new Animation("surfAnim", "position.y", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
        animY.setKeys([
            { frame: 0, value: surface.position.y },
            { frame: 30, value: targetPosY }
        ]);
        animY.setEasingFunction(ease);
        surface.animations = [animY];
        scene.beginAnimation(surface, 0, 30, false);
    },

    setPipeFlow: (scene: Scene, pipeId: string, isActive: boolean) => {
        const flowCore = scene.getMeshByName(`PipeFlow_${pipeId}`) as Mesh;
        const glow = scene.getMeshByName(`PipeGlow_${pipeId}`) as Mesh;
        if (!flowCore || !glow) return;

        flowCore.visibility = isActive ? 1 : 0;
        
        const mat = glow.material as StandardMaterial;
        if (mat) {
             // Animate intense emissive pulse
             if (isActive) {
                 mat.emissiveColor = new Color3(0, 0.4, 0.8);
                 glow.visibility = 0.5;
             } else {
                 mat.emissiveColor = new Color3(0, 0, 0);
                 glow.visibility = 0;
             }
        }
    },

    setPumpState: (scene: Scene, pumpId: string, state: "IDLE" | "ACTIVE" | "WARNING" | "ERROR", value?: number) => {
        const indicator = scene.getMeshByName(`PumpIndicator_${pumpId}`);
        const glow = scene.getMeshByName(`PumpGlow_${pumpId}`);
        if (!indicator || !glow) return;

        const indMat = indicator.material as StandardMaterial;
        const glowMat = glow.material as StandardMaterial;

        // Reset animations if any ongoing
        scene.stopAnimation(glowMat);

        if (state === "ACTIVE") {
            indMat.emissiveColor = new Color3(0.1, 0.8, 0.1); // Green
            glowMat.emissiveColor = new Color3(0, 0.4, 0.1);
            glow.visibility = 0.3;
        } else if (state === "WARNING") {
            indMat.emissiveColor = new Color3(0.9, 0.6, 0); // Amber
            twinAnimations.startBlink(scene, glowMat, new Color3(0.9, 0.6, 0));
        } else if (state === "ERROR") {
            indMat.emissiveColor = new Color3(0.9, 0, 0); // Red
            twinAnimations.startBlink(scene, glowMat, new Color3(0.8, 0, 0));
        } else if (state === "IDLE") {
            indMat.emissiveColor = new Color3(0.3, 0.3, 0.3); // Off/Grey
            glowMat.emissiveColor = new Color3(0, 0, 0);
            glow.visibility = 0;
        }
    },

    triggerAlert: (scene: Scene, targetId: string, severity: "warning" | "error") => {
        // Can target a pump, tank, or pipe
        let targetType = "Pump";
        if (targetId.startsWith("T")) targetType = "Tank";
        if (targetId.startsWith("1") || targetId.startsWith("2")) targetType = "Pipe"; // Based on mapped names 
        // fallback generic matching
        const glowMesh = scene.getMeshByName(`${targetType}Glow_${targetId}`) || scene.getMeshByName(`PumpGlow_${targetId}`) || scene.getMeshByName(`TankGlow_${targetId}`) || scene.getMeshByName(`PipeGlow_${targetId}`);
        
        if (glowMesh) {
            const glowMat = glowMesh.material as StandardMaterial;
            const color = severity === "error" ? new Color3(0.9, 0.1, 0.1) : new Color3(0.9, 0.7, 0);
            twinAnimations.startBlink(scene, glowMat, color);
        }
    },

    startBlink: (scene: Scene, material: StandardMaterial, color: Color3) => {
        const anim = new Animation("blink", "emissiveColor", 10, Animation.ANIMATIONTYPE_COLOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
        anim.setKeys([
            { frame: 0, value: color },
            { frame: 5, value: new Color3(0, 0, 0) },
            { frame: 10, value: color }
        ]);
        material.animations = [anim];
        scene.beginAnimation(material, 0, 10, true);
    }
}
