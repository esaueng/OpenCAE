import * as THREE from "three";

export function highlightPayloadObjectMeshes(
  root: THREE.Object3D,
  activePayloadObjectId: string | null | undefined,
  options: { baseColor: string; highlightColor: string }
): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const active = Boolean(activePayloadObjectId) && child.userData.opencaeObjectId === activePayloadObjectId;
    for (const material of meshMaterials(child.material)) {
      if (!("color" in material) || !(material.color instanceof THREE.Color)) continue;
      material.color.set(active ? options.highlightColor : options.baseColor);
      if ("emissive" in material && material.emissive instanceof THREE.Color) {
        material.emissive.set(active ? "#1f6fb8" : "#000000");
      }
      if ("emissiveIntensity" in material && typeof material.emissiveIntensity === "number") {
        material.emissiveIntensity = active ? 0.55 : 0;
      }
    }
  });
}

function meshMaterials(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}
